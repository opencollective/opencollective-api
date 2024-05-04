import '../../server/env';

import { get, toNumber } from 'lodash';

import { checkHasBalanceToPayExpense, setTransferWiseExpenseAsProcessing } from '../../server/graphql/common/expenses';
import models from '../../server/models';

const IS_DRY = process.env.DRY !== 'false';
const checkPathIsUndefined = (object, path) => get(object, path) === undefined;

const checkExpense = async expenseId => {
  const expense = await models.Expense.findByPk(expenseId, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });
  const transactions = await expense.getTransactions();
  if (transactions.length > 0) {
    console.log(`Expense ${expenseId} already has transactions, skipping...`);
    return;
  }
  if (['data.transfer', 'data.quote', 'data.paymentOption'].some(path => checkPathIsUndefined(expense, path))) {
    console.log(`Expense is missing transfer, quote or paymentOption data, ignoring...`);
    return;
  }

  const host = await expense.collective.getHostCollective();
  const payoutMethod = await expense.getPayoutMethod();
  const { feesInHostCurrency } = await checkHasBalanceToPayExpense(host, expense, payoutMethod, {
    useExistingWiseData: true,
  });

  const args = {
    host,
    expense,
    data: expense.data,
    feesInHostCurrency,
    remoteUser: { id: expense.lastEditedById },
  };
  if (!IS_DRY) {
    return setTransferWiseExpenseAsProcessing(args);
  } else {
    console.log('createTransferWiseTransactionsAndUpdateExpense(\n', JSON.stringify(args, null, 2));
  }
};

const main = async (): Promise<void> => {
  if (IS_DRY) {
    console.log('Running in DRY mode! To mutate data set DRY=false when calling this script.');
  }
  const expenseIds = process.argv?.slice(2) || [];
  if (!expenseIds.length) {
    console.log('Usage: pnpm script scripts/wise/fix-missing-transactions.ts [expenseIds...]');
  } else {
    for (const id of expenseIds) {
      await checkExpense(toNumber(id));
    }
  }
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
