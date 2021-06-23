#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { partition } from 'lodash';

import models, { sequelize } from '../../server/models';
import { TransactionSettlementStatus } from '../../server/models/TransactionSettlement';

const startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date('2021-06-01');

if (process.argv.length < 3) {
  console.error('Usage: ./scripts/ledger/split-host-fee-shares.ts migrate|rollback|check');
  process.exit(1);
}

const getHostFeeTransactionsToMigrateQuery = `
  SELECT t.*, host_fee_share.id AS __host_fee_share_id__
  FROM "Transactions" t
  LEFT JOIN "PaymentMethods" pm ON t."PaymentMethodId" = pm.id
  LEFT JOIN "PaymentMethods" spm ON spm.id = pm."SourcePaymentMethodId"
  LEFT JOIN "Transactions" host_fee_share
    ON host_fee_share."TransactionGroup" = t."TransactionGroup"
    AND host_fee_share."kind" = 'HOST_FEE_SHARE'
  LEFT JOIN "TransactionSettlements" settlement
    ON settlement."TransactionGroup" = host_fee_share."TransactionGroup"
    AND settlement."kind" = host_fee_share."kind"
  WHERE t."kind" = 'HOST_FEE'
  AND host_fee_share.id IS NULL
  AND t.type = 'CREDIT'
  AND t."RefundTransactionId" IS NULL -- TODO Check what to do with refunds
  AND t."createdAt" >= :startDate
  -- Filter out stripe as host fee share is directly collected with this service
  AND (pm.service IS NULL OR pm.service != 'stripe')
  AND (spm.service IS NULL OR spm.service != 'stripe')
  AND (settlement."TransactionGroup" IS NULL OR host_fee_share.id IS NULL)
`;

/**
 * /!\ `scripts/ledger/split-host-fees.ts` MUST run before this script to create the HOST_FEE
 * transactions first. If ran first, this script will have no effect.
 */
const migrate = async () => {
  const [hostFeeTransactions] = await sequelize.query(getHostFeeTransactionsToMigrateQuery, {
    replacements: { startDate },
  });

  const results = await Promise.all(
    hostFeeTransactions.map(async transaction => {
      if (transaction['__host_fee_share_id__']) {
        // To work with inconsistent data (mainly dev): handle cases where debt already exists but not the settlement
        const settlementStatus = TransactionSettlementStatus.OWED;
        return models.TransactionSettlement.createForTransaction(transaction, settlementStatus);
      } else {
        const host = await models.Collective.findByPk(transaction.CollectiveId, { paranoid: false });
        return models.Transaction.createHostFeeShareTransactions(transaction, host, false);
      }
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

  if (!hostFees.length) {
    console.log('All good with debts/settlements');
  } else {
    const [withoutDebt, withoutSettlement] = partition(hostFees, transaction => !transaction['__host_fee_share_id__']);

    if (withoutDebt.length) {
      console.warn(`Found ${withoutDebt.length} contributions without host fee share: ${withoutDebt.map(t => t.id)}`);
    }
    if (withoutSettlement.length) {
      console.warn(
        `Found ${withoutSettlement.length} contributions without settlements: ${withoutSettlement.map(t => t.id)}`,
      );
    }
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
