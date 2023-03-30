/**
 * This script can be used whenever PayPal webhooks event types change to update
 * Host's connected accounts.
 */

import '../../server/env';

import { get, reverse } from 'lodash';
import moment from 'moment';

import logger from '../../server/lib/logger';
import { listPayPalTransactions } from '../../server/lib/paypal';
import models, { Op, sequelize } from '../../server/models';
import paypalAdaptive from '../../server/paymentProviders/paypal/adaptiveGateway';
import { paypalRequest, paypalRequestV2 } from '../../server/paymentProviders/paypal/api';
import { PaypalCapture } from '../../server/types/paypal';

const checkOrder = async orderId => {
  const order = await models.Order.findByPk(orderId);
  order.collective = await order.getCollective();
  order.paymentMethod = await order.getPaymentMethod();
  const hostCollective = await order.collective.getHostCollective();
  const paypalOrderId = order.paymentMethod.data?.orderId;

  if (!paypalOrderId) {
    throw new Error('No PayPal order ID found for this order');
  }

  const paypalOrderUrl = `checkout/orders/${paypalOrderId}`;
  const paypalOrderDetails = await paypalRequestV2(paypalOrderUrl, hostCollective, 'GET');
  console.log('==== Order details ====');
  console.log(paypalOrderDetails);

  const captureId = get(paypalOrderDetails, 'purchase_units.0.payments.captures.0.id');
  if (captureId) {
    console.log('==== Last capture details ====');
    await checkPaypalCapture(hostCollective, captureId);
  } else {
    console.log('==== No capture found ====');
  }
};

const checkPaypalCapture = async (host, captureId) => {
  const captureDetails = await paypalRequestV2(`payments/captures/${captureId}`, host, 'GET');
  console.dir(captureDetails, { depth: 10 });
};

const checkExpense = async expenseId => {
  const expense = await models.Expense.findByPk(expenseId, {
    include: [{ association: 'collective' }, { association: 'host' }],
  });

  const paypalTransactionId = expense?.data?.['transaction_id'];
  if (!paypalTransactionId) {
    throw new Error('No PayPal transaction ID found for this expense');
  } else if (!expense.host) {
    throw new Error('No host found for this expense');
  }

  return checkPaypalCapture(expense.host, paypalTransactionId);
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

const showCaptureInfo = async (hostSlug, paypalTransactionId) => {
  const host = await models.Collective.findBySlug(hostSlug);
  const captureUrl = `payments/captures/${paypalTransactionId}`;
  const captureDetails = (await paypalRequestV2(captureUrl, host, 'GET')) as PaypalCapture;
  const dbTransactions = await models.Transaction.findAll({
    where: { data: { paypalCaptureId: paypalTransactionId } },
  });

  console.log('==== Capture details ====');
  console.dir(captureDetails, { depth: 10 });
  console.log('==== Transactions ====');
  dbTransactions.forEach(t => console.log(`${t.id} - ${t.type} - ${t.amount} ${t.currency}`));
};

const showPayPalOrderInfo = async (hostSlug, paypalOrderId) => {
  const host = await models.Collective.findBySlug(hostSlug);
  const orderUrl = `checkout/orders/${paypalOrderId}`;
  const orderDetails = await paypalRequest(orderUrl, null, host, 'GET');
  console.log('==== Order details ====');
  console.dir(orderDetails, { depth: 10 });
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

const showPayPalTransactionInfo = async (hostSlug, transactionId) => {
  const host = await models.Collective.findBySlug(hostSlug);

  // PayPal doesn't let you fetch date ranges greater than 31 days, so we're splitting the date range in chunks
  for (const { fromDate, toDate } of reverse(getDateChunks(moment().subtract(1, 'year'), moment().add(1, 'day')))) {
    let currentPage = 1;
    let totalPages;
    let transactions;

    logger.info(`Fetching transactions between ${fromDate.format('YYYY-MM-DD')} and ${toDate.format('YYYY-MM-DD')}...`);
    do {
      // Fetch all (paginated) transactions from PayPal for this date range
      ({ transactions, currentPage, totalPages } = await listPayPalTransactions(host, fromDate, toDate, {
        fields: 'all',
        currentPage,
        transactionId,
      }));

      // Make sure all transactions exist in the ledger
      if (transactions.length > 0) {
        console.log('==== Capture details ====');
        console.dir(transactions, { depth: 10 });
        return;
      }
    } while (currentPage++ < totalPages);
  }
};

const showAuthorizationInfo = async (hostSlug, authorizationId) => {
  const host = await models.Collective.findBySlug(hostSlug);
  const authorizationUrl = `payments/authorizations/${authorizationId}`;
  const authorizationDetails = await paypalRequestV2(authorizationUrl, host, 'GET');
  console.log('==== Authorization details ====');
  console.dir(authorizationDetails, { depth: 10 });
};

const showPaymentInfo = async paymentId => {
  const paymentDetails = await paypalAdaptive.paymentDetails({ payKey: paymentId });
  console.log('==== Payment details ====');
  console.dir(paymentDetails, { depth: 10 });
};

const main = async (): Promise<void> => {
  const command = process.argv[2];
  switch (command) {
    case 'order':
      return checkOrder(process.argv[3]);
    case 'expense':
      return checkExpense(process.argv[3]);
    case 'payout': {
      const host = await models.Collective.findBySlug(process.argv[3]);
      if (!host) {
        throw new Error(`Could not find host with slug ${process.argv[3]}`);
      } else {
        return checkPaypalCapture(host, process.argv[4]);
      }
    }
    case 'list-hosts':
      return printAllHostsWithPaypalAccounts();
    case 'capture':
      return showCaptureInfo(process.argv[3], process.argv[4]);
    case 'paypal-order':
      return showPayPalOrderInfo(process.argv[3], process.argv[4]);
    case 'paypal-transaction':
      return showPayPalTransactionInfo(process.argv[3], process.argv[4]);
    case 'authorization':
      return showAuthorizationInfo(process.argv[3], process.argv[4]);
    case 'payment':
      return showPaymentInfo(process.argv[3]);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
