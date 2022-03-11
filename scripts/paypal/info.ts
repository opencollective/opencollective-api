/**
 * This script can be used whenever PayPal webhooks event types change to update
 * Host's connected accounts.
 */

import '../../server/env';

import { get } from 'lodash';

import models, { Op, sequelize } from '../../server/models';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api';

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
  console.log(captureDetails);
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
