'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Platform tips under the NEW_PLATFORM_TIPS_LEDGER feature use the APPLICATION_FEE transaction
    // kind (for Stripe application-fee tips). The platform-tips accounts themselves are per-host
    // hosted children created on demand at runtime (see getOrCreateHostPlatformTipsAccount), so this
    // migration only needs to add the enum value.
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'APPLICATION_FEE' AFTER 'ADDED_FUNDS'
    `);
  },

  async down() {
    // Note: enum values cannot easily be removed in Postgres; intentionally not rolling back the kind addition.
  },
};
