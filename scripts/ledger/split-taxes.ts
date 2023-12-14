#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { groupBy, omit, pick } from 'lodash';

import * as PaymentLib from '../../server/lib/payments';
import models, { Op, sequelize } from '../../server/models';

const startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date('2023-01-01');

if (process.argv.length < 3) {
  console.error('Usage: ./scripts/ledger/split-taxes.ts migrate|rollback|check (rollbackTimestamp)');
  process.exit(1);
}

const getTransactionsToMigrateQuery = `
  SELECT *
  FROM "Transactions" t
  WHERE "taxAmount" IS NOT NULL
  AND "taxAmount" != 0
  AND "createdAt" >= :startDate
  AND "isRefund" IS NOT TRUE
  ORDER BY "createdAt" DESC
`;

const BACKUP_COLUMNS = ['amount', 'amountInHostCurrency', 'netAmountInCollectiveCurrency', 'taxAmount'];

const MIGRATION_DATA_FIELD = 'taxMigration';

const migrate = async () => {
  const transactions = await sequelize.query(getTransactionsToMigrateQuery, {
    replacements: { startDate },
    type: sequelize.QueryTypes.SELECT,
    model: models.Transaction,
    mapToModel: true,
  });

  const groupedTransactions = Object.values(groupBy(transactions, 'TransactionGroup'));
  const timestamp = Date.now().toString();
  const transactionsData = { [MIGRATION_DATA_FIELD]: timestamp };
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

    // Caching hosts (small optimization)
    let host;
    if (credit.HostCollectiveId && hostsCache[credit.HostCollectiveId]) {
      host = hostsCache[credit.HostCollectiveId];
    } else {
      host = await credit.getHostCollective();
      hostsCache[host.id] = host;
    }

    const creditPreMigrationData = pick(credit.dataValues, BACKUP_COLUMNS);
    const debitPreMigrationData = pick(debit.dataValues, BACKUP_COLUMNS);

    const transactionToMigrate = credit.kind === 'EXPENSE' ? debit : credit;
    const result = await models.Transaction.createTaxTransactions(transactionToMigrate, {
      ...transactionsData,
      ...transactionToMigrate.data,
    });

    // We're assuming that there are no other fees left. Don't migrate further than what has been done for host fees/processor fees!
    let creditAmount, debitAmount;
    if (result.transaction.type === 'CREDIT') {
      creditAmount = result.transaction.amount;
      debitAmount = -Math.round(result.transaction.amount);
    } else {
      debitAmount = result.transaction.amount;
      creditAmount = -Math.round(result.transaction.amount);
    }

    await credit.update({
      taxAmount: 0,
      amount: creditAmount,
      netAmountInCollectiveCurrency: creditAmount, // We assume there has no other fees at this point, because they are all migrated
      amountInHostCurrency: Math.round(creditAmount * debit.hostCurrencyFxRate),
      data: {
        ...credit.data,
        ...transactionsData,
        preMigrationData: creditPreMigrationData,
      },
    });

    await debit.update({
      taxAmount: 0,
      amount: debitAmount,
      netAmountInCollectiveCurrency: debitAmount, // We assume there has no other fees at this point, because they are all migrated
      amountInHostCurrency: Math.round(debitAmount * debit.hostCurrencyFxRate),
      data: {
        ...debit.data,
        ...transactionsData,
        preMigrationData: debitPreMigrationData,
      },
    });

    // If there is a refund for this transaction, it needs to be updated as well
    if (credit.RefundTransactionId) {
      const refundDebit = await credit.getRefundTransaction();
      const refundCredit = await debit.getRefundTransaction();
      await refundCredit.update({
        taxAmount: 0,
        amount: creditAmount,
        amountInHostCurrency: Math.round(creditAmount / debit.hostCurrencyFxRate),
        data: {
          ...refundCredit.data,
          ...transactionsData,
          preMigrationData: pick(refundCredit.dataValues, BACKUP_COLUMNS),
        },
      });
      await refundDebit.update({
        taxAmount: 0,
        netAmountInCollectiveCurrency: -creditAmount,
        data: {
          ...refundDebit.data,
          ...transactionsData,
          preMigrationData: pick(refundDebit.dataValues, BACKUP_COLUMNS),
        },
      });

      // Create a refund for the host fee
      const taxRefund = {
        ...PaymentLib.buildRefundForTransaction(result.taxTransaction, null, transactionsData),
        TransactionGroup: refundCredit.TransactionGroup,
        createdAt: refundCredit.createdAt,
      };

      const taxRefundTransaction = await models.Transaction.createDoubleEntry(taxRefund);
      await PaymentLib.associateTransactionRefundId(result.taxTransaction, taxRefundTransaction);
    }
  }
};

const rollback = async ([rollbackTimestamp]) => {
  if (!rollbackTimestamp) {
    throw new Error('A migration timestamp must be specified to trigger a rollback. Pass "ALL" to rollback everything');
  }

  const taxMigrationCondition = rollbackTimestamp === 'ALL' ? 'IS NOT NULL' : '= :rollbackTimestamp';

  // 1. Remove related HOST_FEE and PAYMENT_PROCESSOR_FEE transactions
  console.log('Deleting transactions...');
  await sequelize.query(
    `
    BEGIN;
      -- ALTER TABLE "Transactions" DISABLE TRIGGER ALL;

      DELETE
      FROM "Transactions" t
      WHERE "data" ->> '${MIGRATION_DATA_FIELD}' ${taxMigrationCondition}
      AND kind IN ('TAX')
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
        [MIGRATION_DATA_FIELD]: rollbackTimestamp === 'ALL' ? { [Op.not]: null } : rollbackTimestamp,
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
      data: omit(transaction.data, ['preMigrationData', MIGRATION_DATA_FIELD]),
    });
  }

  console.log(`Migrated ${transactions.length}/${transactions.length} transactions`);
};

const check = async () => {
  const [transactionsToMigrate] = await sequelize.query(getTransactionsToMigrateQuery, { replacements: { startDate } });

  if (!transactionsToMigrate.length) {
    console.log('All good with taxes!');
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
