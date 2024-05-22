import '../../server/env';

import { Command } from 'commander';
import { get } from 'lodash';
import moment from 'moment';

import OrderStatus from '../../server/constants/order-status';
import { TransactionKind } from '../../server/constants/transaction-kind';
import logger from '../../server/lib/logger';
import { getHostsWithPayPalConnected } from '../../server/lib/paypal';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op, sequelize } from '../../server/models';
import { paypalRequest, paypalRequestV2 } from '../../server/paymentProviders/paypal/api';
import {
  findTransactionByPaypalId,
  recordPaypalCapture,
  recordPaypalTransaction,
  refundPaypalCapture,
} from '../../server/paymentProviders/paypal/payment';
import {
  fetchPaypalSubscription,
  fetchPaypalTransactionsForSubscription,
} from '../../server/paymentProviders/paypal/subscription';
import { PaypalCapture, PaypalTransaction, PaypalTransactionSearchResult } from '../../server/types/paypal';

// TODO: Move these to command-line options
const START_DATE = new Date(process.env.START_DATE || '2022-02-01');
const END_DATE = new Date(process.env.END_DATE || moment(START_DATE).add(31, 'day').toDate());
const SCRIPT_RUN_DATE = new Date();

const getHostsSlugsFromOptions = async (options: Record<string, unknown>): Promise<string[]> => {
  if (options['hosts']?.['length']) {
    return <string[]>options['hosts'];
  } else {
    const hosts = await getHostsWithPayPalConnected();
    return hosts.map(h => h.slug);
  }
};

/**
 * A generator to paginate the fetch of orders to avoid loading too much at once
 */
async function* getPaypalPaymentOrdersIterator(host, orderWhere) {
  const limit = 100;
  let offset = 0;
  let orders;

  do {
    orders = await models.Order.findAll({
      offset,
      limit,
      order: [['createdAt', 'DESC']],
      where: {
        ...orderWhere,
        createdAt: {
          [Op.gte]: START_DATE,
          [Op.lte]: END_DATE,
        },
      },
      include: [
        {
          association: 'paymentMethod',
          required: true,
          where: {
            service: 'paypal',
            type: 'payment',
          },
        },
        {
          model: models.Transaction,
          required: true,
          where: {
            kind: TransactionKind.CONTRIBUTION,
            type: 'CREDIT',
            HostCollectiveId: host.id,
            isRefund: false,
          },
        },
      ],
    });

    const nbOrders = orders.length;
    while (orders.length) {
      yield orders.shift();
    }

    if (!nbOrders || nbOrders % limit !== 0) {
      break;
    } else {
      offset += nbOrders;
      console.log(`(%) Processed ${nbOrders} orders, offset ${offset}`);
    }
  } while (true);
}

const checkOrder = async (host, order) => {
  const transactions = order.Transactions;
  const creditTransaction = transactions.find(t => t.kind === TransactionKind.CONTRIBUTION && t.type === 'CREDIT');
  const captureId = creditTransaction.data?.capture?.id || creditTransaction.data?.id;
  if (!captureId) {
    logger.warn(`Order ${order.id} has no capture id: ${JSON.stringify(creditTransaction.data)}`);
    return false;
  }

  const captureDetails = await paypalRequestV2(`payments/captures/${captureId}`, host, 'GET');
  if (!captureDetails) {
    logger.warn(`Order ${order.id} has no capture details matching capture ${captureId}`);
    return false;
  } else if (captureDetails.status !== 'COMPLETED') {
    logger.warn(`Order ${order.id} has capture ${captureId} with status ${captureDetails.status}`);
    return false;
  }

  return true;
};

const markOrderAsError = async order => {
  logger.info(`Marking Order ${order.id} as error`);
  await models.Transaction.update({ deletedAt: new Date() }, { where: { OrderId: order.id } });
  await order.update({ status: OrderStatus.ERROR });
};

const findOrdersWithErroneousStatus = async (_, commander) => {
  const options = commander.optsWithGlobals();
  const hostSlugs = await getHostsSlugsFromOptions(options);
  for (const hostSlug of hostSlugs) {
    console.log(`\nChecking host ${hostSlug} for erroneous order statuses...`);
    const host = await models.Collective.findBySlug(hostSlug);
    const orderIterator = getPaypalPaymentOrdersIterator(host, { status: 'PAID' });
    let orderItem = await orderIterator.next();
    let hasError = false;
    while (!orderItem.done) {
      const isValid = await checkOrder(host, orderItem.value);
      hasError = hasError || !isValid;

      if (options['fix'] && !isValid && !parseToBoolean(process.env.DRY)) {
        await markOrderAsError(orderItem.value);
      }

      orderItem = await orderIterator.next();
    }

    if (!hasError) {
      logger.info(`No error found for PayPal orders for host ${hostSlug}`);
    }
  }
};

const loadSubscription = async paypalSubscriptionId => {
  let subscription = await models.Subscription.findOne({ where: { paypalSubscriptionId } });
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

    if (subscription) {
      logger.warn(`Found subscription ${paypalSubscriptionId} in SubscriptionHistories (#${subscription.id})`);
    } else {
      logger.error(`Could not find subscription ${paypalSubscriptionId}`);
      return null;
    }
  }

  return subscription;
};

const getHostFromSubscription = async subscription => {
  const order = await models.Order.findOne({ where: { SubscriptionId: subscription.id } });
  const collective = await order?.getCollective();
  if (!collective.HostCollectiveId) {
    logger.error(`Looks like the collective for subscription (#${subscription.id}) was unhosted`);
    return;
  }

  return models.Collective.findByPk(collective.HostCollectiveId);
};

const showSubscriptionDetails = async paypalSubscriptionId => {
  let currentPage = 1;
  let totalPages;

  // Try to find the subscription somewhere
  let subscription = await models.Subscription.findOne({ where: { paypalSubscriptionId } });
  if (!subscription) {
    [subscription] = await sequelize.query(
      `SELECT * FROM "SubscriptionHistories" WHERE "paypalSubscriptionId" = :paypalSubscriptionId LIMIT 1`,
      { replacements: { paypalSubscriptionId }, type: sequelize.QueryTypes.SELECT },
    );
  }

  if (!subscription) {
    logger.error(`Could not find subscription ${paypalSubscriptionId}`);
    return;
  }

  // Load host from subscription
  const host = await getHostFromSubscription(subscription);
  if (!host) {
    logger.error(`Could not find host for PayPal subscription ${paypalSubscriptionId} (#${subscription.id})`);
    return;
  }

  do {
    const responseSubscription = await fetchPaypalSubscription(host, paypalSubscriptionId);
    const responseTransactions = await fetchPaypalTransactionsForSubscription(host, paypalSubscriptionId);
    totalPages = <number>responseTransactions['totalPages'];
    const formatJSON = obj => JSON.stringify(obj, null, 2);
    logger.info(
      formatJSON({
        subscription: responseSubscription,
        transactions: responseTransactions['transactions'],
      }),
    );
    if (totalPages > 1) {
      throw new Error('Pagination not supported yet');
    }
  } while (currentPage++ < totalPages);
};

const loadDataForSubscription = async paypalSubscriptionId => {
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

  // Load host from subscription
  const requiredAssociations = ['paymentMethod', 'createdByUser', 'collective', 'fromCollective'];
  const order = await models.Order.findOne({
    paranoid: false,
    where: { SubscriptionId: subscription.id },
    include: requiredAssociations.map(association => ({ association, required: false, paranoid: false })),
  });

  if (!order) {
    throw new Error(`Could not find order for PayPal subscription ${paypalSubscriptionId} (#${subscription.id})`);
  }

  const host = await getHostFromSubscription(subscription);
  if (!host || host.deletedAt) {
    throw new Error(`Could not find host for PayPal subscription ${paypalSubscriptionId} (#${subscription.id})`);
  } else if (!requiredAssociations.every(association => order[association] && !order[association].deletedAt)) {
    throw new Error(
      `Could not find all required entities for PayPal subscription ${paypalSubscriptionId} (#${
        subscription.id
      }): ${requiredAssociations.map(association => `${association}: ${Boolean(order[association])}`)}`,
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

  return { subscription, order, host };
};

const reconcileSubscription = async (paypalSubscriptionId: string, _, commander) => {
  const options = commander.optsWithGlobals();
  let currentPage = 1;
  let totalPages;

  // Try to find the subscription somewhere
  const { subscription, order, host } = await loadDataForSubscription(paypalSubscriptionId);

  do {
    const responseSubscription = await fetchPaypalSubscription(host, paypalSubscriptionId);
    const responseTransactions = await fetchPaypalTransactionsForSubscription(host, paypalSubscriptionId);
    totalPages = <number>responseTransactions['totalPages'];

    if (totalPages > 1) {
      throw new Error('Pagination not supported yet');
    }

    // Reconcile transactions
    const dbTransactions = await order.getTransactions({
      where: { type: 'CREDIT', kind: 'CONTRIBUTION' },
      order: [['createdAt', 'ASC']],
    });
    const paypalTransactions = (responseTransactions['transactions'] as PaypalTransaction[]) || [];
    if (dbTransactions.length !== paypalTransactions.length) {
      console.log(
        `Order #${order.id} has ${dbTransactions.length} transactions in DB but ${paypalTransactions.length} in PayPal`,
      );
    }

    const hasPayPalSaleId = id => dbTransactions.find(dbTransaction => dbTransaction.data?.paypalSale?.['id'] === id);
    const notRecordedPaypalTransactions = paypalTransactions.filter(
      paypalTransaction => !hasPayPalSaleId(paypalTransaction.id),
    );

    for (const paypalTransaction of notRecordedPaypalTransactions) {
      const amount = get(paypalTransaction, 'amount_with_breakdown.gross_amount');
      const amountStr = amount ? `${amount['currency_code']} ${amount['value']}` : '~';
      console.log(
        `PayPal transaction ${paypalTransaction.id} ${amountStr} to https://opencollective.com/${order.collective.slug} needs to be recorded in DB (${paypalTransaction['time']})`,
      );
      if (options['fix']) {
        await recordPaypalTransaction(order, paypalTransaction, {
          data: { recordedFrom: 'scripts/paypal/payment-reconciliator.ts' },
          createdAt: new Date(paypalTransaction['time'] as string),
        });
      }
    }

    if (
      // Cancel the order / subscription if it's cancelled in the API
      responseSubscription.status === 'CANCELLED' &&
      order.status !== OrderStatus.CANCELLED &&
      // And it is not using another payment method
      order.paymentMethod?.service === 'paypal' &&
      order.paymentMethod.type === 'subscription' &&
      order.paymentMethod.token === subscription.paypalSubscriptionId
    ) {
      console.log(`Order #${order.id} cancelled in PayPal but not in DB`);
      if (options['fix']) {
        await order.update({ status: OrderStatus.CANCELLED });
        await subscription.update({
          isActive: false,
          deactivatedAt: new Date(responseSubscription['status_update_time'] as string),
        });
      }
    } else if (responseSubscription.status === 'ACTIVE' && order.status !== OrderStatus.ACTIVE) {
      console.log(`Order #${order.id} active in PayPal but not in DB`);
      if (options['fix']) {
        await order.update({ status: OrderStatus.ACTIVE, processedAt: new Date() });
        if (!subscription.activatedAt || !subscription.isActive) {
          await subscription.update({ activatedAt: new Date(), isActive: true });
        }
      }
    }

    if (options['fix']) {
      console.log(`Subscription ${paypalSubscriptionId} reconciled`);
    }
  } while (currentPage++ < totalPages);
};

const cancelSubscription = async (paypalSubscriptionId: string, reason: string, _, commander) => {
  const options = commander.optsWithGlobals();
  const subscription = await loadSubscription(paypalSubscriptionId);
  if (!subscription) {
    return;
  } else if (!subscription.isActive) {
    console.log(`Subscription ${paypalSubscriptionId} is already inactive`);
  } else if (options['run']) {
    console.log(`Canceling subscription ${paypalSubscriptionId} because: ${reason}`);
    const host = await getHostFromSubscription(subscription);
    await subscription.deactivate(reason, host);
  } else {
    console.log(`Would have cancelled subscription ${paypalSubscriptionId} because: ${reason}. Use --run to do it.`);
  }
};

const findOrphanSubscriptions = async (_, commander) => {
  const options = commander.optsWithGlobals();
  const reason = `Some PayPal subscriptions were previously not cancelled properly. Please contact support@opencollective.com for any question.`;
  const hostSlugs = await getHostsSlugsFromOptions(options);
  const allHosts = await models.Collective.findAll({ where: { slug: hostSlugs } });
  const orphanContributions = await sequelize.query(
    `
    SELECT
      pm."token" AS "paypalSubscriptionId",
      pm."CollectiveId" AS "fromCollectiveId",
      array_agg(DISTINCT transaction_candidates."HostCollectiveId") AS "possibleHostIds",
      array_agg(DISTINCT transaction_candidates."OrderId") AS "possibleOrderIds"
    FROM
      "PaymentMethods" pm
    INNER JOIN "Collectives" c ON
      pm."CollectiveId" = c.id
    INNER JOIN "PaymentMethods" other_pms ON
      other_pms."CollectiveId" = c.id
      AND other_pms.service != 'paypal'
    INNER JOIN "Transactions" transaction_candidates ON
      transaction_candidates."kind" = 'CONTRIBUTION'
      AND transaction_candidates."type" = 'CREDIT'
      AND transaction_candidates."PaymentMethodId" = pm.id
      AND transaction_candidates."HostCollectiveId" IN (:hostCollectiveIds)
    LEFT OUTER JOIN "Orders" o ON
      o."PaymentMethodId" = pm.id
    WHERE
      pm.service = 'paypal'
      AND pm."type" = 'subscription'
      AND o.id IS NULL
    GROUP BY
      pm.id
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      replacements: { hostCollectiveIds: allHosts.map(h => h.id) },
    },
  );

  // Use this instead for testing purposes
  // const orphanContributions = [
  //   {
  //     fromCollectiveId: 10884,
  //     paypalSubscriptionId: 'I-95JYW9SEARW6',
  //     possibleHostIds: [9805],
  //     possibleOrderIds: [6406],
  //   },
  // ];

  for (const { possibleOrderIds, paypalSubscriptionId, possibleHostIds } of orphanContributions) {
    console.log(`\nChecking subscription ${paypalSubscriptionId} for missing transactions...`);
    if (possibleHostIds.length !== 1) {
      console.warn(`Could not resolve host for subscription ${paypalSubscriptionId}`);
      continue;
    } else if (possibleOrderIds.length !== 1) {
      console.warn(`Could not resolve order for subscription ${paypalSubscriptionId}`);
      continue;
    }

    const host = await models.Collective.findByPk(possibleHostIds[0]);
    const order = await models.Order.findByPk(possibleOrderIds[0]);

    // List and reconciliate all transactions
    let currentPage = 1;
    let totalPages;
    console.log(`Synchronizing transactions for order #${order.id}/${paypalSubscriptionId}`);
    do {
      const response = await fetchPaypalTransactionsForSubscription(host, paypalSubscriptionId);
      totalPages = <number>response['totalPages'];
      if (totalPages > 1) {
        throw new Error('Pagination not supported yet');
      }

      // Make sure all transactions exist in the ledger
      for (const paypalTransaction of <PaypalTransaction[]>response['transactions']) {
        const paypalTransactionId = <string>paypalTransaction['id'];
        const ledgerTransaction = await findTransactionByPaypalId(paypalTransactionId, {
          HostCollectiveId: host.id,
          OrderId: order.id,
        });

        if (!ledgerTransaction) {
          const amount = get(paypalTransaction, 'amount_with_breakdown.gross_amount');
          const amountStr = amount ? `${amount['currency_code']} ${amount['value']}` : '~';
          console.warn(`Missing PayPal transaction ${paypalTransactionId} in ledger (${amountStr})`);
          if (options['fix']) {
            if (paypalTransaction['status'] !== 'COMPLETED') {
              continue; // Make sure the capture is not pending
            }

            // Record the charge in our ledger
            const transaction = await recordPaypalTransaction(order, paypalTransaction, {
              createdAt: new Date(<string>paypalTransaction['time']),
              data: { createdFromPaymentReconciliatorAt: SCRIPT_RUN_DATE },
            });

            // Refund the transaction
            try {
              await refundPaypalCapture(transaction, paypalTransactionId, null, reason);
            } catch (e) {
              logger.warn(`Could not refund PayPal transaction ${paypalTransactionId}`, e);
            }
          }
        }
      }

      // Cancel this invalid subscription
      if (options['fix']) {
        console.log('Cancelling PayPal subscription...');

        try {
          await paypalRequest(`billing/subscriptions/${paypalSubscriptionId}/cancel`, { reason }, host);
        } catch (e) {
          logger.warn(`Could not cancel PayPal subscription ${paypalSubscriptionId}`, e);
        }
      }
    } while (currentPage++ < totalPages);
  }
};

const findMissingPaypalTransactions = async (_, commander) => {
  const options = commander.optsWithGlobals();
  const hostSlugs = await getHostsSlugsFromOptions(options);
  for (const hostSlug of hostSlugs) {
    console.log(`\nChecking host ${hostSlug} for missing transactions...`);
    const host = await models.Collective.findBySlug(hostSlug);
    let currentPage = 1;
    let totalPages;

    do {
      // List transactions
      const urlParams = new URLSearchParams();
      urlParams.append('fields', 'all');
      urlParams.append('page_size', '500');
      urlParams.append('page', `${currentPage}`);
      urlParams.append('transaction_status', 'S'); // 	The transaction successfully completed without a denial and after any pending statuses.
      urlParams.append('start_date', START_DATE.toISOString());
      urlParams.append('end_date', END_DATE.toISOString());
      const apiUrl = `reporting/transactions?${urlParams.toString()}`;
      const response = await paypalRequest(apiUrl, null, host, 'GET');
      totalPages = <number>response['totalPages'];

      // Make sure all transactions exist in the ledger
      for (const paypalTransaction of <PaypalTransactionSearchResult['transaction_details']>(
        response['transaction_details']
      )) {
        console.log(
          `Checking transaction ${paypalTransaction['transaction_info']['transaction_id']}...`,
          paypalTransaction,
        );
        const transactionInfo = paypalTransaction['transaction_info'];
        const paypalTransactionId = <string>transactionInfo['transaction_id'];
        const ledgerTransaction = await findTransactionByPaypalId(paypalTransactionId, { HostCollectiveId: host.id });
        if (!ledgerTransaction) {
          const captureUrl = `payments/captures/${paypalTransactionId}`;
          const captureDetails = (await paypalRequestV2(captureUrl, host, 'GET')) as PaypalCapture;
          if (captureDetails.status !== 'COMPLETED') {
            continue; // Make sure the capture is not pending
          }

          // Make sure it's happening on a subscription
          console.warn(`Missing PayPal transaction ${paypalTransactionId} in ledger`);
          if (transactionInfo['paypal_reference_id_type'] !== 'SUB') {
            console.error(
              `Found a missing transaction that is not a subscription: ${paypalTransactionId}`,
              paypalTransaction,
            );
            throw new Error('This case is not supported'); // Shouldn't happen, just in case
          }

          // Look for the subscription in DB
          const paypalSubscriptionId = <string>transactionInfo['paypal_reference_id'];
          const { order } = await loadDataForSubscription(paypalSubscriptionId);
          if (options['fix']) {
            await recordPaypalCapture(order, captureDetails, {
              data: { recordedFrom: 'scripts/paypal/payment-reconciliator.ts' },
              createdAt: new Date(captureDetails.create_time),
            });
          } else {
            console.log(
              `Would have recorded transaction ${paypalTransactionId} in ledger for order ${order.id} (${order.collective.slug})`,
            );
          }
        }
      }

      console.log(`Page ${currentPage}/${totalPages} done`);
    } while (currentPage++ < totalPages);
  }
};

/**
 * See https://developer.paypal.com/docs/api/transaction-search/v1/#transactions-get-query-parameters
 */
const getRefundedTransactionsFromPaypal = async (host, startDate, endDate) => {
  const urlParams = new URLSearchParams();
  urlParams.append('fields', 'all');
  urlParams.append('page_size', '100');
  urlParams.append('page', '1');
  urlParams.append('transaction_status', 'V');
  urlParams.append('start_date', startDate.toISOString());
  urlParams.append('end_date', endDate.toISOString());
  const apiUrl = `reporting/transactions?${urlParams.toString()}`;
  const response = await paypalRequest(apiUrl, null, host, 'GET');
  // TODO: Handle pagination
  return response['transaction_details'];
};

const findRefundedContributions = async (_, commander) => {
  const options = commander.optsWithGlobals();
  const hostSlugs = await getHostsSlugsFromOptions(options);
  for (const hostSlug of hostSlugs) {
    console.log(`\nChecking host ${hostSlug} for refunded contributions not marked as such in our ledger...`);
    let hasError = false;
    try {
      const host = await models.Collective.findBySlug(hostSlug);
      const paypalTransactions = await getRefundedTransactionsFromPaypal(host, START_DATE, END_DATE);
      console.log(JSON.stringify(paypalTransactions, null, 2));
    } catch (e) {
      hasError = true;
      logger.error(`Failed to check refunded contributions for ${hostSlug}: ${e.message}`);
    }

    if (!hasError) {
      logger.info(`No error found for PayPal orders for ${hostSlug}`);
    }
  }
};

const main = async () => {
  const program = new Command();
  program.showSuggestionAfterError();

  const commaSeparatedArgs = list => list.split(',');

  // General options
  program.option(
    '--hosts <slugs>',
    'List of host slugs. Defaults to all hosts with a PayPal account',
    commaSeparatedArgs,
  );

  // Commands
  program.command('refunds').action(findRefundedContributions);
  program.command('invalid-orders').option('--fix').action(findOrdersWithErroneousStatus);
  program.command('transactions').option('--fix').action(findMissingPaypalTransactions);
  program.command('orphan-subscriptions').option('--fix').action(findOrphanSubscriptions);
  program.command('subscription-details <subscriptionId>').action(showSubscriptionDetails);
  program.command('subscription <subscriptionId>').option('--fix').action(reconcileSubscription);
  program.command('cancel <subscriptionId> <reason>').option('--run').action(cancelSubscription);

  // Parse arguments
  await program.parseAsync();
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
