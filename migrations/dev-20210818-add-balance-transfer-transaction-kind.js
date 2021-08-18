'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'BALANCE_TRANSFER' AFTER 'PREPAID_PAYMENT_METHOD'
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "kind" = 'CONTRIBUTION'
      WHERE "kind" = 'BALANCE_TRANSFER'
    `);

    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind" RENAME TO "enum_Transactions_kind_old";
    `);

    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_Transactions_kind" as enum ('ADDED_FUNDS', 'CONTRIBUTION', 'EXPENSE', 'HOST_FEE', 'HOST_FEE_SHARE', 'HOST_FEE_SHARE_DEBT', 'PAYMENT_PROCESSOR_FEE', 'PLATFORM_FEE', 'PLATFORM_TIP', 'PLATFORM_TIP_DEBT', 'PREPAID_PAYMENT_METHOD')
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "Transactions" ALTER COLUMN "kind" TYPE "enum_Transactions_kind" USING "kind"::text::"enum_Transactions_kind"
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "TransactionSettlements" ALTER COLUMN "kind" TYPE "enum_Transactions_kind" USING "kind"::text::"enum_Transactions_kind"
    `);

    await queryInterface.sequelize.query(`
      DROP TYPE "enum_Transactions_kind_old"
    `);
  },
};
