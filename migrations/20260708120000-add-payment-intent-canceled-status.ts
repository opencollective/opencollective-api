'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_PaymentIntents_status"
      ADD VALUE IF NOT EXISTS 'CANCELED' AFTER 'ERROR'
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM pg_enum
      WHERE enumlabel = 'CANCELED'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'enum_PaymentIntents_status')
    `);
  },
};
