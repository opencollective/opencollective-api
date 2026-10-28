import '../../server/env';

import { partition } from 'lodash';

import type { Transaction } from '../../server/models';
import models, { sequelize } from '../../server/models';
import { TransactionSettlementStatus } from '../../server/models/TransactionSettlement';

/** Rows returned by the query below (`t.*` plus the joined debt/host columns) */
type TipCreditTransactionRow = Transaction & {
  __debt_id__?: number;
  __tip_collected_by_host_id__?: number;
};

/** Rows returned by the `check` query below */
type TransactionWithoutSettlementRow = {
  id: number;
  DebtTransactionId: number | null;
  settlementStatus: string;
};

const startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date('2021-05-01');

const migrate = async (): Promise<void> => {
  const [tipCreditTransactions] = (await sequelize.query(
    `
    SELECT t.*, debt.id as __debt_id__, ot."HostCollectiveId" AS __tip_collected_by_host_id__
    FROM "Transactions" t
    INNER JOIN "Transactions" ot ON
      t."TransactionGroup" = ot."TransactionGroup"
      AND ot.type = t.type
      AND ot.kind IN ('CONTRIBUTION', 'ADDED_FUNDS')
    LEFT JOIN "PaymentMethods" pm ON t."PaymentMethodId" = pm.id
    LEFT JOIN "PaymentMethods" spm ON spm.id = pm."SourcePaymentMethodId"
    LEFT JOIN "Transactions" debt
      ON debt."TransactionGroup" = t."TransactionGroup"
      AND debt."kind" = 'PLATFORM_TIP_DEBT'
      AND debt."isDebt" IS TRUE
    LEFT JOIN "TransactionSettlements" s
      ON s."TransactionGroup" = debt."TransactionGroup"
      AND s."kind" = debt."kind"
    WHERE t.kind = 'PLATFORM_TIP'
    AND t.type = 'CREDIT'
    AND t."RefundTransactionId" IS NULL
    AND t."isDebt" IS NOT TRUE
    AND t."createdAt" >= :startDate
    AND (pm.service IS NULL OR pm.service != 'stripe')
    AND (spm.service IS NULL OR spm.service != 'stripe')
    AND (s."TransactionGroup" IS NULL OR debt.id IS NULL)
  `,
    {
      replacements: { startDate },
    },
  )) as [TipCreditTransactionRow[], unknown];

  const results = await Promise.all(
    tipCreditTransactions.map(async transaction => {
      if (transaction['__debt_id__']) {
        // To work with inconsistent data (mainly dev): handle cases where debt already exists but not the settlement
        const settlementStatus = TransactionSettlementStatus.OWED;
        return models.TransactionSettlement.createForTransaction(transaction, settlementStatus);
      } else {
        // The debt must be recorded against the host that collected the tip, not against the platform
        const platformTipTransaction = await models.Transaction.findByPk(transaction.id);
        return models.Transaction.createPlatformTipDebtTransactions({
          platformTipTransaction,
          transaction: { ...transaction, HostCollectiveId: transaction['__tip_collected_by_host_id__'] },
        });
      }
    }),
  );

  console.info(`${results.length} platform tips migrated`);
};

const rollback = async (): Promise<void> => {
  await sequelize.query(
    `
    BEGIN;
      DELETE FROM "TransactionSettlements"
      WHERE "kind" = 'PLATFORM_TIP_DEBT'
      AND "TransactionGroup" IN (
        SELECT "TransactionGroup"
        FROM "Transactions" t
        WHERE t.kind = 'PLATFORM_TIP'
        AND t.type = 'CREDIT'
        AND t."createdAt" >= :startDate
      );

      DELETE FROM "Transactions"
      WHERE "isDebt" = TRUE
      AND kind = 'PLATFORM_TIP_DEBT'
      AND "TransactionGroup" IN (
        SELECT "TransactionGroup"
        FROM "Transactions" t
        WHERE t.kind = 'PLATFORM_TIP'
        AND t.type = 'CREDIT'
        AND t."createdAt" >= :startDate
      );
    COMMIT;
  `,
    {
      replacements: { startDate },
    },
  );
};

const check = async (): Promise<void> => {
  const nbSettlements = await models.TransactionSettlement.count();
  console.log(`${nbSettlements} active settlements`);

  const [transactionsWithoutSettlements] = (await sequelize.query(
    `
    SELECT t.id as "id", debt.id as "DebtTransactionId", s.status as "settlementStatus"
    FROM "Transactions" t
    LEFT JOIN "PaymentMethods" pm ON t."PaymentMethodId" = pm.id
    LEFT JOIN "PaymentMethods" spm ON spm.id = pm."SourcePaymentMethodId"
    LEFT JOIN "Transactions" debt
      ON debt."TransactionGroup" = t."TransactionGroup"
      AND debt."kind" = 'PLATFORM_TIP_DEBT'
      AND debt."isDebt" IS TRUE
    LEFT JOIN "TransactionSettlements" s
      ON s."TransactionGroup" = debt."TransactionGroup"
      AND s."kind" = debt."kind"
    WHERE t.kind = 'PLATFORM_TIP'
    AND t."RefundTransactionId" IS NULL
    AND t."createdAt" >= :startDate
    AND t."isDebt" IS NOT TRUE
    AND t.type = 'CREDIT'
    AND (pm.service IS NULL OR pm.service != 'stripe')
    AND (spm.service IS NULL OR spm.service != 'stripe')
    AND (s."TransactionGroup" IS NULL OR debt.id IS NULL)
  `,
    {
      replacements: { startDate },
    },
  )) as [TransactionWithoutSettlementRow[], unknown];

  if (!transactionsWithoutSettlements.length) {
    console.log('All good with debts/settlements');
  } else {
    const [withoutDebt, withoutSettlement] = partition(
      transactionsWithoutSettlements,
      transaction => !transaction.DebtTransactionId,
    );

    if (withoutDebt.length) {
      console.warn(`Found ${withoutDebt.length} transactions without debts: ${withoutDebt.map(t => t.id)}`);
    }
    if (withoutSettlement.length) {
      console.warn(
        `Found ${withoutSettlement.length} transactions without settlements: ${withoutSettlement.map(t => t.id)}`,
      );
    }
  }
};

const main = async (): Promise<void> => {
  if (process.argv.length < 3) {
    console.error('Usage: ./scripts/ledger/create-debts-for-platform-tips.ts migrate|rollback|check');
    process.exit(1);
  }

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

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
