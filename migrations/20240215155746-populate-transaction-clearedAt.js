'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [, metadata] = await queryInterface.sequelize.query(`
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
            AND "createdAt" >= '2024-01-01'
            AND kind IN ('CONTRIBUTION', 'EXPENSE', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')
          GROUP BY "TransactionGroup"
          )

      UPDATE "Transactions"
      SET "clearedAt" = u."clearedAt"
      FROM to_update u
      WHERE u."clearedAt" IS NOT NULL AND "Transactions"."TransactionGroup" = u."TransactionGroup";
    `);

    console.info(metadata.rowCount, 'transactions updated with clearedAt');
  },

  async down(queryInterface) {
    const [, metadata] = await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "clearedAt" = null
      WHERE "clearedAt" IS NOT NULL;
    `);

    console.info(metadata.rowCount, 'Transactions.clearedAt reseted');
  },
};
