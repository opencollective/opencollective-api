'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'PLATFORM_TIP_DEBT' AFTER 'PLATFORM_TIP'
    `);

    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'HOST_FEE_SHARE_DEBT' AFTER 'HOST_FEE_SHARE'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "kind" = 'PLATFORM_TIP_DEBT'
      WHERE "kind" = 'PLATFORM_TIP'
      AND "isDebt" = TRUE
    `);

    await queryInterface.sequelize.query(`
      UPDATE "TransactionSettlements"
      SET "kind" = 'PLATFORM_TIP_DEBT'
      WHERE "kind" = 'PLATFORM_TIP'
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "kind" = 'PLATFORM_TIP'
      WHERE "kind" = 'PLATFORM_TIP_DEBT'
    `);

    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      DROP VALUE IF NOT EXISTS 'PLATFORM_TIP_DEBT' AFTER 'PLATFORM_TIP'
    `);

    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      DROP VALUE IF NOT EXISTS 'HOST_FEE_SHARE_DEBT' AFTER 'HOST_FEE_SHARE'
    `);
  },
};
