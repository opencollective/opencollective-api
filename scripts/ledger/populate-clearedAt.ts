#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { ifStr } from '../../server/lib/utils';
import { sequelize } from '../../server/models';

const startDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date('2024-01-01T00:00:00Z');
const rewrite = process.env.REWRITE === 'true';
const isDry = process.env.DRY_RUN !== 'false';

if (isDry) {
  console.warn('DRY RUN: No changes will be made');
}

const main = async () => {
  const [groups, meta] = await sequelize.query(
    `
    WITH
      to_update AS (
        SELECT
          "TransactionGroup",
          MIN(COALESCE(
                  TO_TIMESTAMP((data #>> '{dispute,balance_transactions,0,created}')::INT),
                  TO_TIMESTAMP((data #>> '{charge,dispute,balance_transactions,0,created}')::INT),
                  TO_TIMESTAMP((data #>> '{review,created}')::INT),
                  TO_TIMESTAMP((data #>> '{refund,created}')::INT),
                  TO_TIMESTAMP((data #>> '{charge,created}')::INT),
                  TO_TIMESTAMP((data #>> '{transaction,created}')::INT),
                  (data #>> '{paypalSale,create_time}')::TIMESTAMP,
                  (data #>> '{paypalTransaction,time}')::TIMESTAMP,
                  (data #>> '{capture,create_time}')::TIMESTAMP,
                  (data #>> '{time_processed}')::TIMESTAMP,
                  (data #>> '{transfer,created}')::TIMESTAMP,
                  "createdAt"
              )) AS "clearedAt"
        FROM "Transactions"
        WHERE "deletedAt" IS NULL
          AND "createdAt" >= :startDate
          ${ifStr(!rewrite, 'AND "clearedAt" IS NULL')}
          AND kind IN ('CONTRIBUTION', 'EXPENSE', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
        GROUP BY "TransactionGroup"
      )

      ${ifStr(isDry, `SELECT * FROM to_update;`)}
      ${ifStr(
        !isDry,
        `
        UPDATE "Transactions"
        SET "clearedAt" = u."clearedAt"
        FROM to_update u
        WHERE u."clearedAt" IS NOT NULL AND "Transactions"."TransactionGroup" = u."TransactionGroup";
      `,
      )}
  `,
    { replacements: { startDate } },
  );

  if (isDry) {
    console.info('Will update groups:');
    console.dir(groups);
  } else {
    console.info(meta.rowCount, 'transactions updated.');
  }
};

if (!module.parent) {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.info(
      '\nPopulate missing Transactions.clearedAt values.\nPass in REWRITE=true env variable to update clearedAt for all transactions.\n\nUsage: [DRY_RUN=false] [REWRITE=true/false] npm run script scripts/ledger/populate-clearedAt.ts\n',
    );
    process.exit();
  }
  main()
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
