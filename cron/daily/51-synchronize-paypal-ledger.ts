/**
 * A script to reconcile PayPal ledgers with the database. Implemented as a CRON job, bu can safely be run manually;
 * especially on longer period of time (we actually ran it to reconcile the ledger of 2022).
 */

import '../../server/env';

import { get, groupBy } from 'lodash';
import moment from 'moment';
import { QueryTypes } from 'sequelize';

import FEATURE from '../../server/constants/feature';
import OrderStatuses from '../../server/constants/order-status';
import { floatAmountToCents } from '../../server/lib/currency';
import logger from '../../server/lib/logger';
import { createRefundTransaction } from '../../server/lib/payments';
import { getHostsWithPayPalConnected, listPayPalTransactions } from '../../server/lib/paypal';
import { recordOrderProcessed } from '../../server/lib/recurring-contributions';
import { reportErrorToSentry, reportMessageToSentry } from '../../server/lib/sentry';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Collective, Order, sequelize } from '../../server/models';
import Transaction from '../../server/models/Transaction';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api';
import { recordPaypalCapture } from '../../server/paymentProviders/paypal/payment';
import { PaypalCapture, PaypalTransactionSearchResult } from '../../server/types/paypal';
import { runCronJob } from '../utils';

const DISABLE_PAYPAL_SYNC = process.env.DISABLE_PAYPAL_SYNC ? parseToBoolean(process.env.DISABLE_PAYPAL_SYNC) : false;
const LIMITED_TO_HOST_SLUGS = process.env.HOST ? process.env.HOST.split(',') : null;
const EXCLUDED_HOST_SLUGS = process.env.EXCLUDED_HOST ? process.env.EXCLUDED_HOST.split(',') : null;
const START_DATE = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc().subtract(2, 'day');
const END_DATE = process.env.END_DATE ? moment.utc(process.env.END_DATE) : moment(START_DATE).add(1, 'day');
const DRY_RUN = process.env.DRY_RUN ? parseToBoolean(process.env.DRY_RUN) : false;
const ONLY_CHECK_PAYPAL = process.env.ONLY_CHECK_PAYPAL ? parseToBoolean(process.env.ONLY_CHECK_PAYPAL) : false;

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

// Refund event types to detect missing refunds directly from the transaction list
const REFUND_EVENT_TYPES = [
  'T1107', // Refund Payment
];

// Ignore some hosts, usually because they haven't enabled transactions search API yet
// Checked again on 2026-04-15
const IGNORED_HOSTS = [
  'dxura',
  'lucyparsonsinstitute',
  'naarprdfw',
  'taon',
  'tts-miniature-wargames-collective',
  'lucy-parsons-labs',
  'osgeo-foundation',
  'secdsm',
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
  const results = await sequelize.query<{ paypalId: string }>(
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
      type: QueryTypes.SELECT,
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
        type: QueryTypes.SELECT,
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
  let order: Order, subscription;
  const paypalSubscriptionId = transaction.transaction_info.paypal_reference_id;
  try {
    ({ order, subscription } = await loadDataForSubscription(paypalSubscriptionId, host));
  } catch (e) {
    logger.error(`Error while loading data for subscription ${paypalSubscriptionId}: ${e.message}`);
    reportErrorToSentry(e, { extra: { paypalSubscriptionId, transaction } });
    return;
  }

  const msg = `Record subscription transaction ${transaction.transaction_info.transaction_id} for order #${order.id}`;
  logger.info(DRY_RUN ? `DRY RUN: ${msg}` : msg);
  if (!DRY_RUN) {
    const captureDate = new Date(captureDetails.create_time);
    const isFirstPayment = subscription?.chargeNumber === 0;
    const dbTransaction = await recordPaypalCapture(order, captureDetails, {
      data: { recordedFrom: 'cron/daily/51-synchronize-paypal-ledger' },
      createdAt: captureDate,
    });

    if (subscription) {
      await subscription.update({ lastChargedAt: captureDate });
    }

    // If the capture is less than 48 hours old, send the thank you email
    await recordOrderProcessed(order, dbTransaction, {
      skipEmail: moment().diff(captureDate, 'hours') > 48,
      isFirstPayment,
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
    include: [
      { association: 'collective', required: true, where: { HostCollectiveId: host.id } },
      { association: 'fromCollective' },
    ],
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
    const captureDate = new Date(captureDetails.create_time);
    const dbTransaction = await recordPaypalCapture(order, captureDetails, {
      data: { recordedFrom: 'cron/daily/51-synchronize-paypal-ledger' },
      createdAt: captureDate,
    });

    if (order.status !== OrderStatuses.PAID) {
      await order.update({ status: OrderStatuses.PAID, processedAt: captureDate });

      // If the capture is less than 48 hours old, send the thank you email
      await recordOrderProcessed(order, dbTransaction, {
        skipEmail: moment().diff(captureDate, 'hours') > 48,
      });
    }
  }
};

/**
 * From a full list of PayPal transactions for the period, find refund events (T1107) whose
 * corresponding contribution is recorded in the database but has no refund entry yet.
 *
 * Each T1107 transaction carries the original capture ID in `paypal_reference_id` (type TXN) and
 * its own `transaction_id` is the refund ID — so we never need to call `payments/captures/` to
 * discover whether a capture was refunded or to look up the refund ID.
 *
 * Returns pairs of [paypalRefundDetails, dbTransaction] for each match found.
 */
const getMissingRefundTransactions = async (
  transactions: PaypalTransactionSearchResult['transaction_details'],
  host: Collective,
): Promise<Array<[Record<string, unknown>, Transaction]>> => {
  // Keep only refund events that reference an original capture via a TXN reference
  const refundTransactions = transactions.filter(
    t =>
      REFUND_EVENT_TYPES.includes(t.transaction_info.transaction_event_code) &&
      t.transaction_info.paypal_reference_id_type === 'TXN' &&
      t.transaction_info.paypal_reference_id,
  );

  if (!refundTransactions.length) {
    return [];
  }

  // Map original capture ID -> refund transaction (transaction_id = the refund ID)
  const refundByOriginalCaptureId = Object.fromEntries(
    refundTransactions.map(t => [t.transaction_info.paypal_reference_id, t]),
  );
  const captureIds = Object.keys(refundByOriginalCaptureId);

  // Find DB contributions whose paypalCaptureId is one of those original capture IDs
  // and that have no refund recorded yet.
  const candidates = await sequelize.query<{ id: number; paypalCaptureId: string }>(
    `SELECT t.id, t.data #>> '{paypalCaptureId}' AS "paypalCaptureId"
     FROM "Transactions" t
     WHERE
       t.data #>> '{paypalCaptureId}' IS NOT NULL
       AND t.data #>> '{paypalCaptureId}' IN (:captureIds)
       AND t.type = 'CREDIT'
       AND t.kind = 'CONTRIBUTION'
       AND t."isRefund" = FALSE
       AND t."RefundTransactionId" IS NULL
       AND t."deletedAt" IS NULL
    `,
    { type: QueryTypes.SELECT, replacements: { captureIds } },
  );

  if (!candidates.length) {
    return [];
  }

  const dbTransactions = await models.Transaction.findAll({
    where: { id: candidates.map(r => r.id) },
  });

  const result: Array<[Record<string, unknown>, Transaction]> = [];
  for (const dbTransaction of dbTransactions) {
    const captureId = (dbTransaction.data as { paypalCaptureId?: string }).paypalCaptureId;
    const refundId = refundByOriginalCaptureId[captureId].transaction_info.transaction_id;

    let refundDetails: Record<string, unknown>;
    try {
      refundDetails = await paypalRequestV2(`payments/refunds/${refundId}`, host, 'GET');
    } catch (e) {
      logger.error(`Error fetching refund ${refundId} for capture ${captureId}: ${e.message}`);
      reportErrorToSentry(e, { extra: { transactionId: dbTransaction.id, captureId, refundId, hostSlug: host.slug } });
      continue;
    }

    result.push([refundDetails, dbTransaction]);
  }

  return result;
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
    let fullResponse;

    logger.info(`Fetching transactions between ${fromDate.format('YYYY-MM-DD')} and ${toDate.format('YYYY-MM-DD')}...`);
    do {
      // Fetch all (paginated) transactions from PayPal for this date range
      try {
        ({ fullResponse, transactions, currentPage, totalPages } = await listPayPalTransactions(
          host,
          fromDate,
          toDate,
          {
            transactionStatus: 'S', // Successful transactions
            fields: 'transaction_info',
            currentPage,
          },
        ));
        if (ONLY_CHECK_PAYPAL) {
          return;
        }
      } catch (e) {
        if (e.message.includes('Authorization failed due to insufficient permissions')) {
          reportMessageToSentry(`PayPal: Skipping @${host.slug} because Transactions Search API is not enabled`, {
            extra: { fullResponse, fromDate, toDate, currentPage, totalPages },
            feature: FEATURE.PAYPAL_DONATIONS,
            severity: 'warning',
          });
          return;
        } else {
          reportErrorToSentry(e, {
            extra: { fullResponse, fromDate, toDate, currentPage, totalPages },
            feature: FEATURE.PAYPAL_DONATIONS,
            severity: 'error',
          });
          return;
        }
      }

      if (!transactions) {
        if (fullResponse?.['total_items'] !== 0) {
          reportMessageToSentry(`Empty response from PayPal sync job while total items is not 0`, {
            extra: { fullResponse, fromDate, toDate, currentPage, totalPages },
            feature: FEATURE.PAYPAL_DONATIONS,
            severity: 'warning',
          });
        }
        break;
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
      } else {
        // Fetch missing transactions details from PayPal
        logger.info(`${missingTransactions.length} transactions seems missing from @${host.slug}'s ledger`);
      }

      for (const transaction of missingTransactions) {
        let captureDetails;
        const captureUrl = `payments/captures/${transaction.transaction_info.transaction_id}`;
        try {
          captureDetails = (await paypalRequestV2(captureUrl, host, 'GET')) as PaypalCapture;
        } catch (e) {
          logger.error(
            `Error while fetching capture details for ${transaction.transaction_info.transaction_id}: ${e.message}`,
          );
          reportErrorToSentry(e, { extra: { transaction, hostSlug: host.slug } });
          continue;
        }

        if (captureDetails.status !== 'COMPLETED') {
          // If status is REFUNDED, we should ideally record the transaction + its refund (not scoped yet)
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

      // Find out which transactions are refunded on PayPal but still marked as paid in the database.
      // We pass the full unfiltered list so that T1107 refund events (excluded from filteredTransactions)
      // are visible to the function.
      const paypalRefundedTransactions = await getMissingRefundTransactions(transactions, host);
      for (const [paypalTransaction, transaction] of paypalRefundedTransactions) {
        const refundedPaypalFee = floatAmountToCents(
          parseFloat(get(paypalTransaction, 'seller_payable_breakdown.paypal_fee.value', '0.00') as string),
        );

        // Throw on partial refunds so they are investigated manually
        const totalRefundedCents = floatAmountToCents(
          parseFloat(get(paypalTransaction, 'seller_payable_breakdown.total_refunded_amount.value', '0') as string),
        );
        const originalProcessorFee = Math.abs(
          transaction.paymentProcessorFeeInHostCurrency ||
            (await transaction.getPaymentProcessorFeeTransaction())?.amountInHostCurrency ||
            0,
        );
        const expectedMinRefund = transaction.amountInHostCurrency - Math.abs(originalProcessorFee);
        if (totalRefundedCents < expectedMinRefund) {
          reportMessageToSentry('PayPal partial refund detected', {
            extra: {
              transactionId: transaction.id,
              expectedMinRefund,
              totalRefundedCents,
            },
            feature: FEATURE.PAYPAL_DONATIONS,
            severity: 'error',
          });
          continue;
        }

        const msg = `Record missing refund for PayPal capture ${(transaction.data as { paypalCaptureId?: string }).paypalCaptureId} (transaction #${transaction.id})`;
        logger.info(DRY_RUN ? `DRY RUN: ${msg}` : msg);
        if (!DRY_RUN) {
          await createRefundTransaction(
            transaction,
            refundedPaypalFee,
            { paypalResponse: paypalTransaction, isRefundedFromPayPal: true },
            null,
          );
        }
      }
    } while (currentPage++ < totalPages);
  }

  logger.info(`✓ All done with @${host.slug}`);
};

export const run = async () => {
  if (DISABLE_PAYPAL_SYNC) {
    logger.info('PayPal sync is disabled, skipping...');
    return;
  }

  const hostsWithPayPal = await getHostsWithPayPalConnected({ onlyPaymentsEnabled: true });
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
  runCronJob('synchronize-paypal-ledger', run, 24 * 60 * 60, { feature: FEATURE.PAYPAL_DONATIONS });
}
