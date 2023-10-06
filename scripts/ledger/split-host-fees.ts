#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { groupBy, omit, pick } from 'lodash';

import * as PaymentLib from '../../server/lib/payments';
import models, { Op, sequelize } from '../../server/models';

const startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date('2021-06-01');

if (process.argv.length < 3) {
  console.error('Usage: ./scripts/ledger/split-host-fees.ts migrate|rollback|check (rollbackTimestamp)');
  process.exit(1);
}

const getTransactionsToMigrateQuery = `
  SELECT *
  FROM "Transactions" t
  WHERE "hostFeeInHostCurrency" IS NOT NULL
  AND "hostFeeInHostCurrency" != 0
  AND "createdAt" >= :startDate
  AND "isRefund" IS NOT TRUE
  ORDER BY "createdAt" DESC
`;

const BACKUP_COLUMNS = [
  'hostFeeInHostCurrency',
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
  const transactionsData = { hostFeeMigration: timestamp };
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

    // Caching hosts (small optimization)
    let host;
    if (credit.HostCollectiveId && hostsCache[credit.HostCollectiveId]) {
      host = hostsCache[credit.HostCollectiveId];
    } else {
      host = await credit.getHostCollective();
      hostsCache[host.id] = host;
    }

    // Create host fee transaction
    const creditPreMigrationData = pick(credit.dataValues, BACKUP_COLUMNS);
    const { hostFeeTransaction } = await models.Transaction.createHostFeeTransactions(credit, host, transactionsData);

    // Update hostFeeInHostCurrency for both DEBIT and CREDIT
    const transactionFees = credit.platformFeeInHostCurrency + credit.paymentProcessorFeeInHostCurrency;
    const transactionTaxes = credit.taxAmount || 0;
    const netAmountInCollectiveCurrency = Math.round(
      (credit.amountInHostCurrency + transactionFees) / credit.hostCurrencyFxRate + transactionTaxes,
    );

    await credit.update({
      hostFeeInHostCurrency: 0,
      netAmountInCollectiveCurrency,
      data: {
        ...credit.data,
        ...transactionsData,
        preMigrationData: creditPreMigrationData,
      },
    });

    await debit.update({
      hostFeeInHostCurrency: 0,
      amount: -Math.round(netAmountInCollectiveCurrency),
      amountInHostCurrency: -Math.round(netAmountInCollectiveCurrency * debit.hostCurrencyFxRate),
      data: {
        ...debit.data,
        ...transactionsData,
        preMigrationData: pick(debit.dataValues, BACKUP_COLUMNS),
      },
    });

    // If there is a refund for this transaction, it needs to be updated as well
    if (credit.RefundTransactionId) {
      const refundDebit = await credit.getRefundTransaction();
      const refundCredit = await debit.getRefundTransaction();
      await refundCredit.update({
        hostFeeInHostCurrency: 0,
        amount: netAmountInCollectiveCurrency,
        amountInHostCurrency: Math.round(netAmountInCollectiveCurrency / debit.hostCurrencyFxRate),
        paymentProcessorFeeInHostCurrency: -credit.paymentProcessorFeeInHostCurrency,
        data: {
          ...refundCredit.data,
          ...transactionsData,
          preMigrationData: pick(refundCredit.dataValues, BACKUP_COLUMNS),
        },
      });
      await refundDebit.update({
        hostFeeInHostCurrency: 0,
        netAmountInCollectiveCurrency: -netAmountInCollectiveCurrency,
        paymentProcessorFeeInHostCurrency: -credit.paymentProcessorFeeInHostCurrency,
        data: {
          ...refundDebit.data,
          ...transactionsData,
          preMigrationData: pick(refundDebit.dataValues, BACKUP_COLUMNS),
        },
      });

      // Create a refund for the host fee
      const hostFeeRefund = {
        ...PaymentLib.buildRefundForTransaction(hostFeeTransaction, null, transactionsData),
        TransactionGroup: refundCredit.TransactionGroup,
        createdAt: refundCredit.createdAt,
      };

      const hostFeeRefundTransaction = await models.Transaction.createDoubleEntry(hostFeeRefund);
      await PaymentLib.associateTransactionRefundId(hostFeeTransaction, hostFeeRefundTransaction);

      // Refund payment processor fee from the host to the collective
      await PaymentLib.refundPaymentProcessorFeeToCollective(
        credit,
        refundCredit.TransactionGroup,
        transactionsData,
        refundCredit.createdAt,
      );
    }
  }
};

const rollback = async () => {
  const rollbackTimestamp = process.argv[3];
  if (!rollbackTimestamp) {
    throw new Error('A migration timestamp must be specified to trigger a rollback. Pass "ALL" to rollback everything');
  }

  const hostFeeMigrationCondition = rollbackTimestamp === 'ALL' ? 'IS NOT NULL' : '= :rollbackTimestamp';

  // 1. Remove related HOST_FEE and PAYMENT_PROCESSOR_FEE transactions
  console.log('Deleting transactions...');
  await sequelize.query(
    `
    BEGIN;
      ALTER TABLE "Transactions" DISABLE TRIGGER ALL;

      DELETE
      FROM "Transactions" t
      WHERE "data" ->> 'hostFeeMigration' ${hostFeeMigrationCondition}
      AND kind IN ('HOST_FEE', 'PAYMENT_PROCESSOR_FEE')
      AND "createdAt" >= :startDate;

      ALTER TABLE "Transactions" ENABLE TRIGGER ALL;
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
        hostFeeMigration: rollbackTimestamp === 'ALL' ? { [Op.not]: null } : rollbackTimestamp,
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
      data: omit(transaction.data, ['preMigrationData', 'hostFeeMigration']),
    });
  }

  console.log(`Migrated ${transactions.length}/${transactions.length} transactions`);
};

const check = async () => {
  const [transactionsToMigrate] = await sequelize.query(getTransactionsToMigrateQuery, { replacements: { startDate } });

  if (!transactionsToMigrate.length) {
    console.log('All good with host fees!');
  } else {
    console.log(`${transactionsToMigrate.length} transaction pair(s) to migrate`);
  }
};

const main = async () => {
  const command = process.argv[2];
  switch (command) {
    case 'migrate':
      return migrate();
    case 'rollback':
      return rollback();
    case 'check':
      return check();
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
