'use strict';

import type { QueryInterface } from 'sequelize';

/**
 * Nest ManualPaymentProvider bank details under data.accountDetails instead of storing
 * them at the root of the JSONB blob.
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "ManualPaymentProviders"
      SET "data" = jsonb_build_object('accountDetails', "data")
      WHERE "data" IS NOT NULL
      AND NOT ("data" ? 'accountDetails')
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "ManualPaymentProviders"
      SET "data" = "data" -> 'accountDetails'
      WHERE "data" IS NOT NULL
      AND "data" ? 'accountDetails'
    `);
  },
};
