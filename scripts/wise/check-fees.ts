import '../../server/env';

import assert from 'assert';

import { Command } from 'commander';
import { omit, pick } from 'lodash';
import moment from 'moment';

import { Service } from '../../server/constants/connected-account';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { computeExpenseAmounts } from '../../server/lib/transactions';
import * as transferwiseLib from '../../server/lib/transferwise';
import models, { Op, sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { ExpenseDataQuoteV3 } from '../../server/types/transferwise';

const program = new Command();

const MIGRATION_DATA_KEY = 'checkFeesMigrationData';
const POST_MIGRATION_DATA_KEY = 'migratedCheckFeesData';
const IS_DRY = process.env.DRY !== 'false';

program.command('check <since> <until> [hosts]').action(async (since, until, hosts) => {
  try {
    since = moment.utc(since);
    assert(since.isValid(), 'Invalid date for since');
    until = moment.utc(until);
    assert(until.isValid(), 'Invalid date for until');
    hosts = hosts ? hosts.split(',') : ['opensource', 'europe', 'opencollective'];
    console.log(`Checking fees for expenses created between ${since} and ${until} for hosts ${hosts.join(', ')}...`);
  } catch (e) {
    console.error(e.message);
    await sequelize.close();
    return;
  }

  for (const slug of hosts) {
    const expenses = await models.Expense.findAll({
      where: {
        status: 'PAID',
        createdAt: { [Op.between]: [since, until] },
        data: { transfer: { [Op.ne]: null }, [MIGRATION_DATA_KEY]: null },
      },
      include: [
        { model: models.Collective, as: 'collective' },
        {
          model: models.Collective,
          as: 'host',
          required: true,
          where: { slug },
        },
        {
          model: models.PayoutMethod,
          as: 'PayoutMethod',
          required: true,
          where: { type: PayoutMethodTypes.BANK_ACCOUNT },
        },
      ],
    });
    console.log(`Found ${expenses.length} expenses for ${slug}...`);
    const host = await models.Collective.findOne({ where: { slug } });
    const [connectedAccount] = await host.getConnectedAccounts({
      where: { service: Service.TRANSFERWISE, deletedAt: null },
    });
    if (!connectedAccount) {
      console.warn(`⚠️ ${slug} not connected to Wise`, 'error');
      continue;
    }

    for (const expense of expenses) {
      try {
        const transfer = await transferwiseLib.getTransfer(connectedAccount, expense.data.transfer['id']);
        assert(transfer.quoteUuid, `Transfer Missing quoteUuid`);
        const quote = await transferwiseLib.getQuote(connectedAccount, transfer.quoteUuid);
        const paymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);

        if (expense.data.paymentOption.fee.total !== paymentOption.fee.total) {
          console.log(
            `\t❌ Expense #${expense.id} for ${expense.collective.slug} has a fee mismatch, persisting info to expense.data.${MIGRATION_DATA_KEY}`,
          );
          const addedData = {
            [MIGRATION_DATA_KEY]: {
              quote: omit(quote, ['paymentOptions']) as ExpenseDataQuoteV3,
              paymentOption,
            },
          };
          if (IS_DRY) {
            console.log(`\t\tDRY RUN: Would have updated expense.data.${MIGRATION_DATA_KEY} with`, addedData);
          } else {
            await expense.update({
              data: {
                ...expense.data,
                ...addedData,
              },
            });
          }
        } else {
          console.log(`\t✅ Expense #${expense.id} for ${expense.collective.slug}`);
        }
      } catch (e) {
        console.log(`\t❌ Expense #${expense.id} for ${expense.collective.slug} failed check: ${e.message}`);
      }
    }
  }

  console.log('Done!');
  sequelize.close();
});

program.command('fix [hosts]').action(async hosts => {
  hosts = hosts ? hosts.split(',') : ['opensource', 'europe', 'opencollective'];
  console.log(`Fix fees for expenses previously checked for hosts ${hosts.join(', ')}...`);
  for (const slug of hosts) {
    const expenses = await models.Expense.findAll({
      where: {
        status: 'PAID',
        data: { [MIGRATION_DATA_KEY]: { [Op.ne]: null }, [POST_MIGRATION_DATA_KEY]: null },
      },
      include: [
        { model: models.Collective, as: 'collective' },
        {
          model: models.Collective,
          as: 'host',
          required: true,
          where: { slug },
        },
        {
          model: models.PayoutMethod,
          as: 'PayoutMethod',
          required: true,
          where: { type: PayoutMethodTypes.BANK_ACCOUNT },
        },
        { model: models.Transaction },
      ],
    });
    console.log(`Found ${expenses.length} expenses ready to fix for ${slug}...`);

    for (const expense of expenses) {
      try {
        const paymentFeeTransactions = expense.Transactions.filter(
          t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE,
        );
        assert(paymentFeeTransactions.length === 2, 'Expected exacty two payment processor fee transactions');

        const { paymentOption, quote } = expense.data[MIGRATION_DATA_KEY] as typeof expense.data;
        const feesInHostCurrency = (expense.data.feesInHostCurrency || {}) as {
          paymentProcessorFeeInHostCurrency: number;
          hostFeeInHostCurrency: number;
          platformFeeInHostCurrency: number;
        };

        if (expense.host?.settings?.transferwise?.ignorePaymentProcessorFees) {
          // TODO: We should not just ignore fees, they should be recorded as a transaction from the host to the collective
          // See https://github.com/opencollective/opencollective/issues/5113
          feesInHostCurrency.paymentProcessorFeeInHostCurrency = 0;
        } else {
          // This is simplified because we enforce sourceCurrency to be the same as hostCurrency
          feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(paymentOption.fee.total * 100);
        }

        const [originalDebitTransaction, ...otherDebits] = paymentFeeTransactions.filter(
          t => t.type === 'DEBIT' && t.kind === TransactionKind.EXPENSE,
        );
        assert(otherDebits.length === 0, 'Expected exactly one original debit transaction');
        assert(originalDebitTransaction, 'Missing original debit transaction');

        const hostAmount =
          expense.feesPayer === 'PAYEE'
            ? paymentOption.sourceAmount
            : paymentOption.sourceAmount - paymentOption.fee.total;
        assert(hostAmount, 'Expense is missing paymentOption information');
        const expenseToHostRate = (hostAmount * 100) / expense.amount;
        const processedAmounts = await computeExpenseAmounts(
          expense,
          expense.host.currency,
          expenseToHostRate,
          feesInHostCurrency,
        );

        const newExpenseData = {
          ...expense.data,
          [POST_MIGRATION_DATA_KEY]: pick(expense.data, ['quote', 'paymentOption', 'feesInHostCurrency']),
          quote,
          paymentOption,
          feesInHostCurrency,
        };

        const paymentProcessorFeeData = {
          hostCurrencyFxRate: processedAmounts.fxRates.collectiveToHost,
          paymentProcessorFeeInHostCurrency: feesInHostCurrency.paymentProcessorFeeInHostCurrency,
        };

        if (IS_DRY) {
          console.log(
            `\tDRY RUN: Would have deleted refund transactions for expense #${expense.id} and updated fees with:`,
          );
          console.log(`\t\tNew expense data:`, newExpenseData);
          console.log(`\t\tNew payment processor fee data:`, paymentProcessorFeeData);
        } else {
          // Update Expense and backup previous data
          await expense.update({
            data: newExpenseData,
          });
          // Soft-delete existing payment fee transactions
          await Promise.all(paymentFeeTransactions.map(t => t.destroy()));

          // Create new ones
          await models.Transaction.createPaymentProcessorFeeTransactions(
            {
              ...originalDebitTransaction.toJSON(),
              ...paymentProcessorFeeData,
            },
            pick(expense.data, ['fund']),
          );
        }

        console.log(`\t✅ Expense #${expense.id} for ${expense.collective.slug}`);
      } catch (e) {
        console.log(`\t❌ Expense #${expense.id} for ${expense.collective.slug} failed fix: ${e.message}`);
      }
    }
  }
});

program.addHelpText(
  'after',
  `

Example call:
  $ DRY=false npm run script scripts/wise/check-fees.ts check 2023-01-01 2024-01-01 host-slug,host-slug2 

  $ DRY=false npm run script scripts/wise/check-fees.ts fix host-slug,host-slug2 
`,
);

program.parse();
