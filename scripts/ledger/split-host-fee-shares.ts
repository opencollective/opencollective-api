#!/usr/bin/env ./node_modules/.bin/ts-node
import '../../server/env.js';

import { partition, uniq } from 'lodash-es';

import models, { sequelize } from '../../server/models/index.js';

const startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date('2021-06-01');

if (process.argv.length < 3) {
  console.error('Usage: ./scripts/ledger/split-host-fee-shares.ts migrate|rollback|check');
  process.exit(1);
}

const getHostFeeTransactionsToMigrateQuery = `
  SELECT t.*
  FROM "Transactions" t
  INNER JOIN "Transactions" contribution
    ON contribution."TransactionGroup" = t."TransactionGroup"
    AND contribution."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS')
  LEFT JOIN "Transactions" host_fee_share
    ON host_fee_share."TransactionGroup" = t."TransactionGroup"
    AND host_fee_share."kind" = 'HOST_FEE_SHARE'
    AND host_fee_share."deletedAt" IS NULL
  WHERE t."kind" = 'HOST_FEE'
  AND contribution."deletedAt" IS NULL
  AND t."deletedAt" IS NULL
  AND t.type = 'CREDIT'
  AND t."RefundTransactionId" IS NULL -- TODO Check what to do with refunds
  AND t."createdAt" >= :startDate
  AND host_fee_share.id IS NULL
  GROUP BY t.id
  ORDER BY t.id DESC
`;

/**
 * /!\ `scripts/ledger/split-host-fees.ts` MUST run before this script to create the HOST_FEE
 * transactions first. If ran first, this script will have no effect.
 */
const migrate = async () => {
  const hostFeeTransactions = await sequelize.query(getHostFeeTransactionsToMigrateQuery, {
    replacements: { startDate },
    model: models.Transaction,
    mapToModel: true,
  });

  const results = [];
  let count = 0;
  for (const hostFeeTransaction of hostFeeTransactions) {
    if (++count % 100 === 0) {
      console.log(`Migrated ${count}/${hostFeeTransactions.length} transactions`);
    }

    const host = await models.Collective.findByPk(hostFeeTransaction.CollectiveId, { paranoid: false });
    const transaction = await hostFeeTransaction.getRelatedTransaction({ kind: ['CONTRIBUTION', 'ADDED_FUNDS'] });
    // TODO preload Payment method to define wether debts have ben created automatically
    const result = await models.Transaction.createHostFeeShareTransactions(
      { transaction, hostFeeTransaction },
      host,
      false,
    );

    results.push(Boolean(result));
  }

  const [migrated, ignored] = partition(results, Boolean);

  console.info(`${migrated.length} host fee shares migrated, ${ignored.length} transactions ignored`);
};

const rollback = async () => {
  console.log('Delete transactions...');
  const [transactions] = await sequelize.query(
    `
    DELETE
    FROM "Transactions" t
    WHERE (t."kind" = 'HOST_FEE_SHARE' OR t."kind" = 'HOST_FEE_SHARE_DEBT')
    AND t."createdAt" < '2021-07-01 09:36:00'
    AND t."createdAt" >= :startDate
    RETURNING t."TransactionGroup"
  `,
    {
      replacements: { startDate },
    },
  );

  console.log(`${transactions.length} transactions deleted`);

  if (transactions.length) {
    console.log(`Delete settlements for ${transactions.length} transactions...`);
    await sequelize.query(
      `
      DELETE
      FROM "TransactionSettlements" ts
      WHERE ts."kind" = 'HOST_FEE_SHARE_DEBT'
      AND ts."TransactionGroup" IN (:transactionGroups)
    `,
      {
        replacements: {
          transactionGroups: uniq(transactions.map(t => t.TransactionGroup)),
        },
      },
    );
  }
};

const check = async () => {
  const [hostFees] = await sequelize.query(getHostFeeTransactionsToMigrateQuery, {
    replacements: { startDate },
  });

  if (hostFees.length) {
    console.info(`Found ${hostFees.length} contributions without host fee share: ${hostFees.map(t => t.id)}`);
  } else {
    console.info('All up to date!');
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
