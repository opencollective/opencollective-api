/**
 * Updates the total paid amount for an expense, adapting the FX rate accordingly.
 */

import '../../server/env';

import { Command } from 'commander';

import models from '../../server/models';
import { confirm } from '../common/helpers';

const IS_DRY = process.env.DRY !== 'false';

/** Parse command-line arguments */
const getProgram = argv => {
  const program = new Command();

  // Misc options
  program.argument('<ExpenseId>', 'Id of the expense to update');
  program.argument('<newTotalAmount>', 'New total amount to set');

  // Parse arguments
  program.parse(argv);

  return program;
};

// Main
const main = async (argv = process.argv) => {
  const program = getProgram(argv);
  const [ExpenseId, newTotalAmountStr] = program.args;
  const transactions = await models.Transaction.findAll({ where: { ExpenseId } });
  const newTotalAmount = parseInt(newTotalAmountStr);

  if (!transactions.length) {
    throw new Error(`No transactions found for expense #${ExpenseId}`);
  } else if (transactions.length !== 2) {
    throw new Error(`Expected 2 transactions for expense #${ExpenseId}, found ${transactions.length}`);
  }

  const credit = transactions.find(t => t.type === 'CREDIT');
  const debit = transactions.find(t => t.type === 'DEBIT');
  const host = await debit.getHostCollective();

  // Make sure we're in the right currency setup
  if (transactions.some(t => t.currency !== host.currency)) {
    throw new Error(`Expected all transactions to be in ${host.currency}`);
  }

  // Update values
  credit.amount = newTotalAmount;
  credit.amountInHostCurrency = newTotalAmount;
  credit.netAmountInCollectiveCurrency = newTotalAmount + credit.paymentProcessorFeeInHostCurrency;

  debit.netAmountInCollectiveCurrency = -newTotalAmount;
  debit.amountInHostCurrency = -(newTotalAmount + debit.paymentProcessorFeeInHostCurrency);
  debit.amount = -(newTotalAmount + debit.paymentProcessorFeeInHostCurrency);

  // Set new FX rate
  const expense = await models.Expense.findByPk(ExpenseId);
  const expenseToHostFxRate = credit.netAmountInCollectiveCurrency / expense.amount;
  credit.data = { ...credit.data, expenseToHostFxRate };
  debit.data = { ...debit.data, expenseToHostFxRate };

  // Verify
  console.log('Validating credit...');
  await models.Transaction.validate(credit, { oppositeTransaction: debit });
  console.log('Validating debit...');
  await models.Transaction.validate(debit, { oppositeTransaction: credit });

  // Log changes
  console.log('You are about to make the following changes:');
  console.log('ExpenseId ; TransactionId ; Field ; Old value ; New value');
  transactions.forEach(transaction => {
    (transaction.changed() as string[]).forEach(field => {
      console.log(
        `${ExpenseId} ; ${transaction.id} ; ${field} ; ${JSON.stringify(
          transaction['_previousDataValues'][field],
        )} ; ${JSON.stringify(transaction[field])}`,
      );
    });
  });

  // Save
  if (!IS_DRY) {
    await confirm('Do you want to proceed?');
    await Promise.all(transactions.map(t => t.save()));
    console.log(`Processed ${transactions.length}/${transactions.length} transactions...`);
  } else {
    console.log('Dry run, nothing was saved');
  }
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch(e => {
      if (e.name !== 'CommanderError') {
        console.error(e);
      }

      process.exit(1);
    });
}
