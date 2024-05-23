import '../../server/env';

import { isNil, last } from 'lodash';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import { parseToBoolean } from '../../server/lib/utils';
import { Op, sequelize } from '../../server/models';
import Expense from '../../server/models/Expense';
import PayoutMethod from '../../server/models/PayoutMethod';
import Transaction from '../../server/models/Transaction';

const IS_DRY = !process.env.DRY ? true : parseToBoolean(process.env.DRY);
const DATE_FROM = new Date(process.env.DATE_FROM || '2024-01-01');

const populatePaymentMethod = async expense => {
  const isManual = last(expense.Transactions as Array<Transaction>)?.data?.isManual;
  // Automatically settlements that can be associated based on payout method and data
  if (
    !isManual &&
    ((expense.PayoutMethod?.type === 'BANK_ACCOUNT' && !isNil(expense.data?.transfer)) || // Wise
      (expense.PayoutMethod?.type === 'PAYPAL' && !isNil(expense.data?.payout_item_id)) || // PayPal Payouts
      !isNil(expense.VirtualCardId) || // VirtualCards
      expense.PayoutMethod?.type === 'ACCOUNT_BALANCE')
  ) {
    if (!IS_DRY) {
      await expense.setAndSavePaymentMethodIfMissing();
    } else {
      const paymentMethod = await expense.fetchPaymentMethod();
      console.log(
        `Expense #${expense.id} with payout (${expense.PayoutMethod?.type}) should have payment method ${paymentMethod.service} ${paymentMethod.type}`,
      );
    }
  }
  // Manually set payment method for PayPal Payouts
  else if (expense.PayoutMethod?.type === 'PAYPAL' && isManual) {
    const host = await expense.getHost();
    if (!IS_DRY) {
      const paymentMethod = await host.findOrCreatePaymentMethod(
        PAYMENT_METHOD_SERVICE.PAYPAL,
        PAYMENT_METHOD_TYPE.MANUAL,
      );
      expense.setPaymentMethod(paymentMethod);
      await expense.save();
    } else {
      console.log(
        `Expense #${expense.id} with payout (PAYPAL) should have payment method ${PAYMENT_METHOD_SERVICE.PAYPAL} ${PAYMENT_METHOD_TYPE.MANUAL}`,
      );
    }
  }
};

const migrate = async () => {
  const expenses = await Expense.findAll({
    where: {
      status: 'PAID',
      PaymentMethodId: null,
    },
    include: [
      PayoutMethod,
      {
        association: 'Transactions',
        where: {
          type: 'DEBIT',
          kind: 'EXPENSE',
          createdAt: { [Op.gte]: DATE_FROM },
          isRefund: false,
        },
        required: true,
      },
    ],
    order: [[sequelize.col('Transactions.createdAt'), 'DESC']],
  });
  console.log(`Found ${expenses.length} expenses missing payment method`);
  for (const expense of expenses) {
    await populatePaymentMethod(expense).catch(e => {
      console.error(`\nError populating payment method for expense ${expense.id}: ${expense.description}\n`, e);
    });
  }
};

const main = async () => {
  console.log('Populating expenses with payment method');
  console.log(`Running with DRY: ${IS_DRY}, DATE_FROM: ${DATE_FROM}`);
  return migrate();
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
