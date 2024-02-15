'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [, metadata] = await queryInterface.sequelize.query(`
      WITH to_update AS (SELECT
        id,
        data,
        kind,
        "createdAt",
        "TransactionGroup",
        COALESCE(
                to_timestamp((data#>>'{charge,created}')::INT),
                to_timestamp((data#>>'{transaction,created}')::INT),
                (data #>> '{paypalSale,create_time}')::TIMESTAMP,
                (data #>> '{paypalTransaction,time}')::TIMESTAMP,
                (data #>> '{capture,create_time}')::TIMESTAMP,
                (data #>> '{time_processed}')::TIMESTAMP,
                (data #>> '{transfer,created}')::TIMESTAMP
        ) AS "clearedAt"
      FROM "Transactions"
      WHERE
        "deletedAt" IS NULL
        AND "createdAt" >= '2024-01-01'::DATE
        AND kind IN ('CONTRIBUTION', 'EXPENSE')
        AND type = 'CREDIT')

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
