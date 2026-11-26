'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_AccountingCategories_kind"
      ADD VALUE IF NOT EXISTS 'BALANCE_ACCOUNT'
    `);
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_AccountingCategories_kind"
      ADD VALUE IF NOT EXISTS 'CLEARING_ACCOUNT'
    `);
  },

  async down(queryInterface: QueryInterface) {
    for (const value of ['BALANCE_ACCOUNT', 'CLEARING_ACCOUNT']) {
      await queryInterface.sequelize.query(
        `
        DELETE FROM pg_enum
        WHERE enumlabel = :value
          AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'enum_AccountingCategories_kind')
      `,
        { replacements: { value } },
      );
    }
  },
};
