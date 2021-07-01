#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { partition } from 'lodash';

import models, { sequelize } from '../../server/models';

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
  LEFT JOIN "PaymentMethods" pm ON contribution."PaymentMethodId" = pm.id
  LEFT JOIN "PaymentMethods" spm ON spm.id = pm."SourcePaymentMethodId"
  LEFT JOIN "Transactions" host_fee_share
    ON host_fee_share."TransactionGroup" = t."TransactionGroup"
    AND host_fee_share."kind" = 'HOST_FEE_SHARE'
  WHERE t."kind" = 'HOST_FEE'
  AND t.type = 'CREDIT'
  AND t."RefundTransactionId" IS NULL -- TODO Check what to do with refunds
  AND t."createdAt" >= :startDate
  -- Filter out stripe as host fee share is directly collected with this service
  AND (pm.service IS NULL OR pm.service != 'stripe')
  AND (spm.service IS NULL OR spm.service != 'stripe')
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

  const results = await Promise.all(
    hostFeeTransactions.map(async hostFeeTransaction => {
      const host = await models.Collective.findByPk(hostFeeTransaction.CollectiveId, { paranoid: false });
      const transaction = await hostFeeTransaction.getRelatedTransaction({ kind: ['CONTRIBUTION', 'ADDED_FUNDS'] });
      return models.Transaction.createHostFeeShareTransactions({ transaction, hostFeeTransaction }, host, false);
    }),
  );

  const [migrated, ignored] = partition(results, Boolean);

  console.info(`${migrated.length} host fee shares migrated, ${ignored.length} transactions ignored`);
};

const rollback = async () => {
  // TODO
  await sequelize.query(``, {
    replacements: { startDate },
  });
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
