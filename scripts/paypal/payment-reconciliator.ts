#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env';

import OrderStatus from '../../server/constants/order_status';
import { TransactionKind } from '../../server/constants/transaction-kind';
import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op, sequelize } from '../../server/models';
import { paypalRequest, paypalRequestV2 } from '../../server/paymentProviders/paypal/api';

const exitWithUsage = () => {
  console.error(
    'Usage: ./scripts/paypal/payment-reconciliator.ts check-invalid-orders|fix-invalid-orders|check-refunds [HOST_SLUGS]',
  );
  process.exit(1);
};

const START_DATE = new Date(process.env.START_DATE || '2020-01-01');
const END_DATE = new Date(process.env.END_DATE || new Date());

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

const findOrdersWithErroneousStatus = async (hostSlugs: string[], fix = false) => {
  for (const hostSlug of hostSlugs) {
    console.log(`\nChecking host ${hostSlug} for erroneous order statuses...`);
    const host = await models.Collective.findBySlug(hostSlug);
    const orderIterator = getPaypalPaymentOrdersIterator(host, { status: 'PAID' });
    let orderItem = await orderIterator.next();
    let hasError = false;
    while (!orderItem.done) {
      const isValid = await checkOrder(host, orderItem.value);
      hasError = hasError || !isValid;

      if (fix && !isValid && !parseToBoolean(process.env.DRY)) {
        await markOrderAsError(orderItem.value);
      }

      orderItem = await orderIterator.next();
    }

    if (!hasError) {
      logger.info(`No error found for PayPal orders for host ${hostSlug}`);
    }
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

const findRefundedContributions = async (hostSlugs: string[]) => {
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

const getHostsSlugs = async (): Promise<string[]> => {
  if (process.argv[3]) {
    return process.argv[3].split(',');
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
  const command = process.argv[2];
  if (!command) {
    return exitWithUsage();
  }

  const hostSlugs = await getHostsSlugs();
  switch (command) {
    case 'check-invalid-orders':
      return findOrdersWithErroneousStatus(hostSlugs, false);
    case 'fix-invalid-orders':
      return findOrdersWithErroneousStatus(hostSlugs, true);
    case 'check-refunds':
      return findRefundedContributions(hostSlugs);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
