#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env';

import { Command } from 'commander';
import moment from 'moment';

import OrderStatus from '../../server/constants/order_status';
import { TransactionKind } from '../../server/constants/transaction-kind';
import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op, sequelize } from '../../server/models';
import { paypalRequest, paypalRequestV2 } from '../../server/paymentProviders/paypal/api';

// TODO: Move these to command-line options
const START_DATE = new Date(process.env.START_DATE || '2022-02-01');
const END_DATE = new Date(process.env.END_DATE || moment(START_DATE).add(31, 'day').toDate());

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

const findOrdersWithErroneousStatus = async options => {
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

const findMissingPaypalTransactions = async options => {
  const hostSlugs = await getHostsSlugsFromOptions(options);
  for (const hostSlug of hostSlugs) {
    console.log(`\nChecking host ${hostSlug} for missing transactions...`);
    const host = await models.Collective.findBySlug(hostSlug);
    let currentPage = 1;
    let totalPages = 1;

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
      for (const paypalTransaction of <Record<string, unknown>[]>response['transaction_details']) {
        const transactionInfo = paypalTransaction['transaction_info'];
        const paypalTransactionId = <string>transactionInfo['transaction_id'];
        const ledgerTransaction = await models.Transaction.findOne({
          where: {
            HostCollectiveId: host.id, // Pre-filter to make the query faster
            data: {
              [Op.or]: [{ capture: { id: paypalTransactionId } }, { paypalSale: { id: paypalTransactionId } }],
            },
          },
        });

        if (!ledgerTransaction) {
          console.warn(`Missing PayPal transaction ${paypalTransactionId} in ledger`);
          if (options['fix']) {
            // Trigger the actual charge

            const captureDetails = await paypalRequestV2(`payments/captures/${paypalTransactionId}`, host, 'GET');
            if (captureDetails.status !== 'COMPLETED') {
              continue; // Make sure the capture is not pending
            }

            // Record the charge in our ledger
            // TODO
            // const order = await models.Order.findOne({});
            // return recordPaypalCapture(order, captureDetails, {
            //   createdAt: new Date(transactionInfo['transaction_initiation_date']),
            //   data: { createdFromPaymentReconciliatorAt: new Date() },
            // });
          }
        }
      }
      return;
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

const findRefundedContributions = async options => {
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

const getHostsSlugsFromOptions = async (options: Record<string, unknown>): Promise<string[]> => {
  if (options['hosts']?.['length']) {
    return <string[]>options['hosts'];
  } else {
    const hosts = await models.Collective.findAll({
      where: { isHostAccount: true },
      group: [sequelize.col('Collective.id')],
      include: [
        {
          association: 'ConnectedAccounts',
          required: true,
          attributes: [],
          where: { service: 'paypal', clientId: { [Op.not]: null }, token: { [Op.not]: null } },
        },
      ],
    });

    return hosts.map(h => h.slug);
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

  // Filters
  program.command('refunds').action(findRefundedContributions);
  program.command('invalid-orders').option('--fix').action(findOrdersWithErroneousStatus);
  program.command('transactions').option('--fix').action(findMissingPaypalTransactions);

  // Parse arguments
  await program.parseAsync();
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
