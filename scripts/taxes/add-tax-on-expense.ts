#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env.js';

import { Command } from 'commander';
import { sum } from 'lodash-es';

import models, { sequelize } from '../../server/models/index.js';

const program = new Command()
  .description('Helper to add a tax on an existing expense')
  .arguments('TaxId ExpenseId')
  .option('--run', 'Trigger changes')
  .option('--force', 'Override existing taxes')
  .parse();

const getGrossAmount = (amount, taxRate) => Math.round(amount / (1 + taxRate));
const getTaxAmount = (amount, taxRate) => Math.round(amount - getGrossAmount(amount, taxRate));

const main = async () => {
  const taxId = program.args[0];
  const expenseId = program.args[1];
  const options = program.opts();

  if (taxId !== 'GST') {
    throw new Error('Only GST is supported for now');
  } else if (!options['run']) {
    console.log('This is a dry run, use --run to trigger changes');
  }

  // Load expense
  const expense = await models.Expense.findByPk(expenseId, { include: [{ association: 'items' }] });
  if (!expense) {
    throw new Error(`Expense ${expenseId} not found`);
  } else if (expense.data?.taxes?.['length'] && !options['force']) {
    throw new Error(`Expense ${expenseId} already has taxes`);
  }

  let transactions = [];
  if (expense.status === 'PAID') {
    transactions = await expense.getTransactions();
    if (transactions.length !== 2) {
      throw new Error(`Expense ${expenseId} has ${transactions.length} transactions instead of 2`);
    }
  }

  const tax = { type: 'GST', id: 'GST', rate: 0.15, percentage: 15 };
  const taxAmountFromExpense = getTaxAmount(expense.amount, tax.rate);
  const taxAmountFromItems = sum(expense.items.map(i => getTaxAmount(i.amount, tax.rate)));
  if (taxAmountFromExpense !== taxAmountFromItems) {
    throw new Error(
      `Expense ${expenseId} has different tax amounts from items (${taxAmountFromExpense} vs ${taxAmountFromItems})`,
    );
  }

  console.log(`Needs to add tax ${taxId} for ${taxAmountFromExpense} on expense ${expenseId}`);

  if (options['run']) {
    await sequelize.transaction(async transaction => {
      // Update expense
      await expense.update({ data: { ...expense.data, taxes: [tax] } }, { transaction });

      // Update items
      await Promise.all(
        expense.items.map(item => item.update({ amount: getGrossAmount(item.amount, tax.rate) }, { transaction })),
      );

      // Update transactions
      if (transactions.length) {
        const credit = transactions.find(t => t.type === 'CREDIT');
        const debit = transactions.find(t => t.type === 'DEBIT');
        await credit.update({ taxAmount: -taxAmountFromExpense, data: { ...credit.data, tax } }, { transaction });
        await debit.update({ taxAmount: -taxAmountFromExpense, data: { ...debit.data, tax } }, { transaction });
      }

      console.log('Done!');
    });
  }
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
