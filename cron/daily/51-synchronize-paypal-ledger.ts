/**
 * A script to reconcile PayPal ledgers with the database. Implemented as a CRON job, bu can safely be run manually;
 * especially on longer period of time (we actually ran it to reconcile the ledger of 2022).
 */

import '../../server/env';

import { groupBy } from 'lodash';
import moment from 'moment';

import FEATURE from '../../server/constants/feature';
import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { getHostsWithPayPalConnected, listPayPalTransactions } from '../../server/lib/paypal';
import { closeRedisClient } from '../../server/lib/redis';
import { reportErrorToSentry, reportMessageToSentry } from '../../server/lib/sentry';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Collective, sequelize } from '../../server/models';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api';
import { recordPaypalCapture } from '../../server/paymentProviders/paypal/payment';
import { PaypalCapture, PaypalTransactionSearchResult } from '../../server/types/paypal';

const LIMITED_TO_HOST_SLUGS = process.env.HOST ? process.env.HOST.split(',') : null;
const EXCLUDED_HOST_SLUGS = process.env.EXCLUDED_HOST ? process.env.EXCLUDED_HOST.split(',') : null;
const START_DATE = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc().subtract(2, 'day');
const END_DATE = process.env.END_DATE ? moment.utc(process.env.END_DATE) : moment(START_DATE).add(1, 'day');
const DRY_RUN = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : false;

// Filter out transactions that are not related to contributions
// See https://developer.paypal.com/docs/transaction-search/transaction-event-codes/
const WATCHED_EVENT_TYPES = [
  // Subscription
  'T0002',
  // PayPal checkout. These ones are now necessarily recorded in the database, but before we moved to "AUTHORIZE" intent
  // instead of "CAPTURE" (in https://github.com/opencollective/opencollective-frontend/pull/8601) we got some cases where
  // the transactions were never recorded.
  'T0006',
];

// Ignore some hosts, usually because they haven't enabled transactions search API yet
const IGNORED_HOSTS = [
  // Token is invalid
  'access2perspectives',
  // Transactions search API is not enabled
  'allforclimate',
  'arcadianodes',
  'better-together',
  'bruijnlogistics',
  'deeptimewalk-cic',
  'cct',
  'heroes-of-newerth-community',
  'lucy-parsons-labs',
  'madeinjlm',
  'monachelle',
  'nfsc',
  'osgeo-foundation',
  'ppy',
  'proofing-future',
  'secdsm',
  'stroud-district-community-hubs',
  'the-book-haven-npc',
  'thenewoilmedia',
  'wildseed-society',
];

/**
 * From a list of PayPal transactions, find the ones that are not recorded in the database.
 */
const getMissingTransactions = async (
  transactions: PaypalTransactionSearchResult['transaction_details'],
): Promise<PaypalTransactionSearchResult['transaction_details']> => {
  if (transactions.length === 0) {
    return [];
  }

  const groupedTransactions = groupBy(transactions, 'transaction_info.transaction_id');
  const results = await sequelize.query(
    `
      SELECT *
      FROM UNNEST(ARRAY[:paypalIds]) "paypalId"
      WHERE NOT EXISTS (
        SELECT 1
        FROM "Transactions" t
        WHERE t."data" #>> '{paypalCaptureId}' = "paypalId"
          AND "deletedAt" IS NULL
      )
    `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: { paypalIds: Object.keys(groupedTransactions) },
    },
  );

  return results.map(r => groupedTransactions[r.paypalId][0]);
};

/**
 * Load subscription and all its associations. Will fail if the subscription is not found or has missing associations.
 */
const loadDataForSubscription = async (paypalSubscriptionId, expectedHost) => {
  let subscription = await models.Subscription.findOne({ where: { paypalSubscriptionId }, paranoid: false });
  if (!subscription) {
    [subscription] = await sequelize.query(
      `SELECT * FROM "SubscriptionHistories" WHERE "paypalSubscriptionId" = :paypalSubscriptionId LIMIT 1`,
      {
        replacements: { paypalSubscriptionId },
        type: sequelize.QueryTypes.SELECT,
        mapToModel: true,
        model: models.Subscription,
      },
    );
  }

  if (!subscription) {
    throw new Error(`Could not find subscription ${paypalSubscriptionId}`);
  }

  // Load associations
  const requiredAssociations = ['paymentMethod', 'createdByUser', 'collective', 'fromCollective'];
  const order = await models.Order.findOne({
    paranoid: false,
    where: { SubscriptionId: subscription.id },
    include: requiredAssociations.map(association => ({ association, required: false, paranoid: false })),
  });

  if (!order) {
    throw new Error(`Could not find order for PayPal subscription ${paypalSubscriptionId} (#${subscription.id})`);
  }

  if (!requiredAssociations.every(association => order[association] && !order[association].deletedAt)) {
    const getAssociationStatus = association =>
      !order[association]
        ? `${association}: missing`
        : order[association].deletedAt
          ? `${association}: deleted`
          : `${association}: ok`;
    throw new Error(
      `Could not find all required associations for PayPal subscription ${paypalSubscriptionId} (subscription #${
        subscription.id
      }): ${requiredAssociations.map(getAssociationStatus).join(', ')}`,
    );
  } else if (
    subscription.deletedAt ||
    order.deletedAt ||
    !requiredAssociations.every(association => !order[association].deletedAt)
  ) {
    throw new Error(
      `Subscription ${subscription.id} has deleted entities, please restore them first: ${requiredAssociations.map(
        association => `${association}: ${Boolean(order[association])}`,
      )}`,
    );
  }

  // Check host
  const host = await order.collective.getHostCollective();
  if (!host) {
    throw new Error(
      `Could not find host for PayPal subscription ${paypalSubscriptionId} (subscription #${subscription.id})`,
    );
  } else if (expectedHost.id !== host.id) {
    throw new Error(
      `Host mismatch for PayPal subscription ${paypalSubscriptionId} (subscription #${subscription.id}): expected ${expectedHost.slug}, got ${host.slug}`,
    );
  }

  return { subscription, order };
};

/**
 * Subscriptions are an easy case, we only need to record the capture
 */
const handleSubscriptionTransaction = async (
  host: Collective,
  transaction: PaypalTransactionSearchResult['transaction_details'][0],
  captureDetails: PaypalCapture,
) => {
  let order;
  const paypalSubscriptionId = transaction.transaction_info.paypal_reference_id;
  try {
    ({ order } = await loadDataForSubscription(paypalSubscriptionId, host));
  } catch (e) {
    logger.error(`Error while loading data for subscription ${paypalSubscriptionId}: ${e.message}`);
    reportErrorToSentry(e, { extra: { paypalSubscriptionId, transaction } });
    return;
  }

  const msg = `Record subscription transaction ${transaction.transaction_info.transaction_id} for order #${order.id}`;
  logger.info(DRY_RUN ? `DRY RUN: ${msg}` : msg);
  if (!DRY_RUN) {
    return recordPaypalCapture(order, captureDetails, {
      data: { recordedFrom: 'cron/daily/51-synchronize-paypal-ledger' },
      createdAt: new Date(captureDetails.create_time),
    });
  }
};

/**
 * Records a checkout transaction
 */
const handleCheckoutTransaction = async (
  host: Collective,
  transaction: PaypalTransactionSearchResult['transaction_details'][0],
  captureDetails: PaypalCapture,
): Promise<void> => {
  const captureId = transaction.transaction_info.transaction_id;
  const order = await models.Order.findOne({
    where: { data: { paypalCaptureId: captureId } },
    include: [{ association: 'collective', required: true, where: { HostCollectiveId: host.id } }],
  });

  if (!order) {
    // The transaction could be something that happened outside the platform, just log a warning
    reportMessageToSentry(`Could not find order for PayPal capture ${captureId}`, {
      extra: { hostSlug: host.slug, captureDetails, transaction },
      feature: FEATURE.PAYPAL_DONATIONS,
      severity: 'warning',
    });
    return;
  }

  const msg = `Record checkout transaction ${transaction.transaction_info.transaction_id} for order #${order.id}`;
  logger.info(DRY_RUN ? `DRY RUN: ${msg}` : msg);
  if (!DRY_RUN) {
    await recordPaypalCapture(order, captureDetails, {
      data: { recordedFrom: 'cron/daily/51-synchronize-paypal-ledger' },
      createdAt: new Date(captureDetails.create_time),
    });

    if (order.status !== OrderStatuses.PAID) {
      await order.update({ status: OrderStatuses.PAID });
    }
  }
};

/**
 * Split a given period in chunks of `nbOfDays` days
 */
const getDateChunks = (fromDate: moment.Moment, toDate: moment.Moment, nbOfDays = 30) => {
  const dateChunks = [];
  let chunkFromDate = fromDate.clone();
  while (chunkFromDate.isBefore(toDate)) {
    dateChunks.push({ fromDate: chunkFromDate.clone(), toDate: chunkFromDate.clone().add(nbOfDays, 'days') });
    chunkFromDate = chunkFromDate.add(nbOfDays, 'days');
  }

  // Make sure end date for last chunk is not after `toDate`
  dateChunks[dateChunks.length - 1].toDate = toDate;

  return dateChunks;
};

const processHost = async (host, periodStart: moment.Moment, periodEnd: moment.Moment) => {
  // PayPal doesn't let you fetch date ranges greater than 31 days, so we're splitting the date range in chunks
  for (const { fromDate, toDate } of getDateChunks(periodStart, periodEnd)) {
    let currentPage = 1;
    let totalPages;
    let transactions;

    logger.info(`Fetching transactions between ${fromDate.format('YYYY-MM-DD')} and ${toDate.format('YYYY-MM-DD')}...`);
    do {
      // Fetch all (paginated) transactions from PayPal for this date range
      try {
        ({ transactions, currentPage, totalPages } = await listPayPalTransactions(host, fromDate, toDate, {
          transactionStatus: 'S', // Successful transactions
          fields: 'transaction_info',
          currentPage,
        }));
      } catch (e) {
        if (e.message.includes('Authorization failed due to insufficient permissions')) {
          logger.warn(`Skipping @${host.slug} because Transactions Search API is not enabled`);
          return;
        } else {
          throw e;
        }
      }

      const filteredTransactions = transactions.filter(t =>
        WATCHED_EVENT_TYPES.includes(t.transaction_info.transaction_event_code),
      );

      // Print period
      logger.info(
        `Page ${currentPage}/${totalPages}: Analyzing ${filteredTransactions.length} of ${transactions.length} transactions...`,
      );

      // Find out which transactions are missing from the database (if any)
      const missingTransactions = await getMissingTransactions(filteredTransactions);
      if (!missingTransactions.length) {
        logger.info(`✓ No missing transactions on page ${currentPage}/${totalPages}`);
        continue;
      }

      // Fetch missing transactions details from PayPal
      logger.info(`${missingTransactions.length} transactions seems missing from @${host.slug}'s ledger`);
      for (const transaction of missingTransactions) {
        const captureUrl = `payments/captures/${transaction.transaction_info.transaction_id}`;
        const captureDetails = (await paypalRequestV2(captureUrl, host, 'GET')) as PaypalCapture;
        if (captureDetails.status !== 'COMPLETED') {
          // TODO: if status is REFUNDED, we should record the transaction + its refund
          logger.debug(
            `Capture ${transaction.transaction_info.transaction_id} is ${captureDetails.status}, skipping...`,
          );
          continue;
        }

        // Handle the transaction differently based on its type
        if (transaction.transaction_info.transaction_event_code === 'T0002') {
          await handleSubscriptionTransaction(host, transaction, captureDetails);
        } else if (transaction.transaction_info.transaction_event_code === 'T0006') {
          await handleCheckoutTransaction(host, transaction, captureDetails);
        }
      }
    } while (currentPage++ < totalPages);
  }

  logger.info(`✓ All done with @${host.slug}`);
};

const run = async () => {
  const hostsWithPayPal = await getHostsWithPayPalConnected();
  const fromDate = START_DATE.startOf('day');
  const toDate = END_DATE.endOf('day');
  const hostsToIgnore = [...IGNORED_HOSTS, ...(EXCLUDED_HOST_SLUGS || [])];
  const hostsToProcess = LIMITED_TO_HOST_SLUGS
    ? hostsWithPayPal.filter(h => LIMITED_TO_HOST_SLUGS.includes(h.slug))
    : hostsWithPayPal.filter(h => !hostsToIgnore.includes(h.slug));

  if (!hostsToProcess.length) {
    logger.info('No hosts to process');
    return;
  } else if (!fromDate || !toDate || fromDate.isAfter(toDate)) {
    logger.error(`Invalid date range: ${fromDate} - ${toDate}`);
  }

  logger.info(`Starting reconciliation job for PayPal transactions between ${fromDate} and ${toDate}`);
  for (let i = 0; i < hostsToProcess.length; i++) {
    const host = hostsToProcess[i];
    logger.info(`\n==== Processing host ${i + 1}/${hostsToProcess.length}: ${host.slug} ====`);
    await processHost(host, fromDate, toDate);
  }
};

if (require.main === module) {
  run()
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e, { feature: FEATURE.PAYPAL_DONATIONS, severity: 'error' });
      process.exit(1);
    })
    .then(() => {
      setTimeout(async () => {
        await closeRedisClient();
        await sequelize.close();
        process.exit(0);
      }, 2000);
    });
}
