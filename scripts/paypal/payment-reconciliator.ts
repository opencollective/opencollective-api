#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env';

import OrderStatus from '../../server/constants/order_status';
import { TransactionKind } from '../../server/constants/transaction-kind';
import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op, sequelize } from '../../server/models';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api';

const exitWithUsage = () => {
  console.error('Usage: ./scripts/paypal/payment-reconciliator.ts check|fix|list-hosts HOST_SLUG');
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
          where: { kind: TransactionKind.CONTRIBUTION, type: 'CREDIT', HostCollectiveId: host.id },
        },
      ],
    });

    const nbOrders = orders.length;
    while (orders.length) {
      yield orders.shift();
    }

    if (!nbOrders || nbOrders % limit != 0) {
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
  const captureId = creditTransaction.data?.capture?.id;
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

const findOrdersWithErroneousStatus = async (hostSlug, fix = false) => {
  if (!hostSlug) {
    return exitWithUsage();
  }

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
    logger.info('No error found for PayPal orders');
  }
};

const printAllHostsWithPaypalAccounts = async () => {
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

  const hostsLabelLists = hosts.map(host => `${host.slug} (#${host.id})`);
  console.log(`Hosts with PayPal: ${hostsLabelLists.join(', ')}`);
};

const main = async () => {
  const command = process.argv[2];
  if (!command) {
    return exitWithUsage();
  }

  switch (command) {
    case 'check':
      return findOrdersWithErroneousStatus(process.argv[3]);
    case 'fix':
      return findOrdersWithErroneousStatus(process.argv[3], true);
    case 'list-hosts':
      return printAllHostsWithPaypalAccounts();
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
