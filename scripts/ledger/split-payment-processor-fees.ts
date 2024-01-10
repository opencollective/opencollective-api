#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { groupBy, omit, pick } from 'lodash';

import models, { Op, sequelize } from '../../server/models';

const startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date('2023-01-01');

if (process.argv.length < 3) {
  console.error('Usage: ./scripts/ledger/split-payment-processor-fees.ts migrate|rollback|check (rollbackTimestamp)');
  process.exit(1);
}

const getTransactionsToMigrateQuery = `
  SELECT *
  FROM "Transactions" t
  WHERE "paymentProcessorFeeInHostCurrency" IS NOT NULL
  AND "paymentProcessorFeeInHostCurrency" != 0
  AND "createdAt" >= :startDate
  AND "isRefund" IS NOT TRUE
  ORDER BY "createdAt" DESC
`;

const BACKUP_COLUMNS = [
  'amount',
  'amountInHostCurrency',
  'netAmountInCollectiveCurrency',
  'paymentProcessorFeeInHostCurrency',
];

const migrate = async () => {
  const transactions = await sequelize.query(getTransactionsToMigrateQuery, {
    replacements: { startDate },
    type: sequelize.QueryTypes.SELECT,
    model: models.Transaction,
    mapToModel: true,
  });

  const groupedTransactions = Object.values(groupBy(transactions, 'TransactionGroup'));
  const timestamp = Date.now().toString();
  const transactionsData = { paymentProcessorFeeMigration: timestamp };
  const hostsCache = {};
  let count = 0;

  console.log(`Migrating ${groupedTransactions.length} transaction pairs...`);

  if (process.env.DRY) {
    console.log('Dry run, aborting');
    return;
  }

  for (const transactions of groupedTransactions) {
    if (++count % 100 === 0) {
      console.log(`Migrated ${count}/${groupedTransactions.length} transaction pairs`);
    }

    const credit = transactions.find(t => t.type === 'CREDIT');
    const debit = transactions.find(t => t.type === 'DEBIT');
    if (!credit || !debit) {
      console.error(`Transaction without matching CREDIT/DEBIT, skipping: ${credit?.id || debit?.id}`);
      continue;
    }

    // TODO: do we have cases where DEBIT and CREDIT have a different currency?
    if (credit.currency !== debit.currency) {
      // In that case, the code does not support it and we have to skip for now
      console.error(`DEBIT and CREDIT have a different currency in ${credit.TransactionGroup}, skipping.`);
      continue;
    }

    const creditPreMigrationData = pick(credit.dataValues, BACKUP_COLUMNS);
    const debitPreMigrationData = pick(debit.dataValues, BACKUP_COLUMNS);

    // Create payment processor fee transaction
    if (credit.kind === 'EXPENSE') {
      await models.Transaction.createPaymentProcessorFeeTransactions(debit, transactionsData);

      const transactionTaxes = debit.taxAmount || 0;

      const debitNetAmountInCollectiveCurrency =
        Math.round((debit.amountInHostCurrency + debit.paymentProcessorFeeInHostCurrency) / debit.hostCurrencyFxRate) +
        transactionTaxes;

      // update netAmountInCollectiveCurrency, amount and amountInHostCurrency should not be affected
      await debit.update({
        paymentProcessorFeeInHostCurrency: 0,
        netAmountInCollectiveCurrency: debitNetAmountInCollectiveCurrency,
        data: {
          ...debit.data,
          ...transactionsData,
          preMigrationData: debitPreMigrationData,
        },
      });

      // update amount and amountInHostCurrency, netAmountInCollectiveCurrency should not be affected
      await credit.update({
        paymentProcessorFeeInHostCurrency: 0,
        amount: -debitNetAmountInCollectiveCurrency,
        amountInHostCurrency: credit.amountInHostCurrency + credit.paymentProcessorFeeInHostCurrency,
        data: {
          ...credit.data,
          ...transactionsData,
          preMigrationData: creditPreMigrationData,
        },
      });
    } else {
      await models.Transaction.createPaymentProcessorFeeTransactions(credit, transactionsData);

      // Update paymentProcessorFeeInHostCurrency for both DEBIT and CREDIT
      const transactionFees = 0; // There is no fee left at this point (platform fee deprecated and host fee already moved on separate transaction)
      const transactionTaxes = credit.taxAmount || 0;
      const netAmountInCollectiveCurrency = Math.round(
        (credit.amountInHostCurrency + transactionFees) / credit.hostCurrencyFxRate + transactionTaxes,
      );

      await credit.update({
        paymentProcessorFeeInHostCurrency: 0,
        netAmountInCollectiveCurrency,
        data: {
          ...credit.data,
          ...transactionsData,
          preMigrationData: creditPreMigrationData,
        },
      });

      await debit.update({
        paymentProcessorFeeInHostCurrency: 0,
        amount: -Math.round(netAmountInCollectiveCurrency),
        amountInHostCurrency: -Math.round(netAmountInCollectiveCurrency * debit.hostCurrencyFxRate),
        data: {
          ...debit.data,
          ...transactionsData,
          preMigrationData: debitPreMigrationData,
        },
      });
    }
  }
};

const rollback = async ([rollbackTimestamp]) => {
  if (!rollbackTimestamp) {
    throw new Error('A migration timestamp must be specified to trigger a rollback. Pass "ALL" to rollback everything');
  }

  const paymentProcessorFeeMigrationCondition = rollbackTimestamp === 'ALL' ? 'IS NOT NULL' : '= :rollbackTimestamp';

  // 1. Remove related HOST_FEE and PAYMENT_PROCESSOR_FEE transactions
  console.log('Deleting transactions...');
  await sequelize.query(
    `
    BEGIN;
      -- ALTER TABLE "Transactions" DISABLE TRIGGER ALL;

      DELETE
      FROM "Transactions" t
      WHERE "data" ->> 'paymentProcessorFeeMigration' ${paymentProcessorFeeMigrationCondition}
      AND kind IN ('PAYMENT_PROCESSOR_FEE')
      AND "createdAt" >= :startDate;

      -- ALTER TABLE "Transactions" ENABLE TRIGGER ALL;
    COMMIT;
  `,
    {
      replacements: {
        startDate,
        rollbackTimestamp,
      },
    },
  );

  // 2. Update the original transactions
  console.log('Fetching transactions to update...');
  const transactions = await models.Transaction.findAll({
    where: {
      createdAt: { [Op.gte]: startDate },
      data: {
        paymentProcessorFeeMigration: rollbackTimestamp === 'ALL' ? { [Op.not]: null } : rollbackTimestamp,
      },
    },
  });

  let count = 0;
  for (const transaction of transactions) {
    if (++count % 100 === 0) {
      console.log(`Migrated ${count}/${transactions.length} transactions`);
    }

    await transaction.update({
      ...(<Record<string, unknown>>transaction.data.preMigrationData),
      data: omit(transaction.data, ['preMigrationData', 'paymentProcessorFeeMigration']),
    });
  }

  console.log(`Migrated ${transactions.length}/${transactions.length} transactions`);
};

const check = async () => {
  const [transactionsToMigrate] = await sequelize.query(getTransactionsToMigrateQuery, { replacements: { startDate } });

  if (!transactionsToMigrate.length) {
    console.log('All good with payment processor fees!');
  } else {
    console.log(`${transactionsToMigrate.length} transaction pair(s) to migrate`);
  }
};

type Command = 'migrate' | 'rollback' | 'check';

export const main = async (command: Command, additionalParameters = undefined) => {
  switch (command) {
    case 'migrate':
      return migrate();
    case 'rollback':
      return rollback(additionalParameters);
    case 'check':
      return check();
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

if (!module.parent) {
  main(process.argv[2] as Command, process.argv.slice(2))
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
