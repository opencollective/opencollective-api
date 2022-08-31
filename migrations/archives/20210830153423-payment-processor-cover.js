'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'PAYMENT_PROCESSOR_COVER' AFTER 'HOST_FEE_SHARE_DEBT'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "kind" = 'PAYMENT_PROCESSOR_COVER', "description" = 'Cover of payment processor fee for refund'
      WHERE "kind" = 'PAYMENT_PROCESSOR_FEE'
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "kind" = 'PAYMENT_PROCESSOR_FEE', "description" = 'Refund of payment processor fees for transaction'
      WHERE "kind" = 'PAYMENT_PROCESSOR_COVER'
    `);

    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind" RENAME TO "enum_Transactions_kind_old";
    `);

    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_Transactions_kind" as enum ('ADDED_FUNDS', 'BALANCE_TRANSFER', 'CONTRIBUTION', 'EXPENSE', 'HOST_FEE', 'HOST_FEE_SHARE', 'HOST_FEE_SHARE_DEBT', 'PAYMENT_PROCESSOR_FEE', 'PLATFORM_FEE', 'PLATFORM_TIP', 'PLATFORM_TIP_DEBT', 'PREPAID_PAYMENT_METHOD')
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
