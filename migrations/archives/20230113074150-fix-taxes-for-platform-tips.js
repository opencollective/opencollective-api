'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Remove taxes from platform tips. Thankfully, all these transactions were initiated from Stripe
    // so there's not PLATFORM_TIP_DEBT transactions to worry about. We also don't need to worry about
    // updating the net amount and other amounts as it seems they were not initially considered in the calculations.
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET
        "taxAmount" = 0,
        "data" = jsonb_set("data", '{taxAmountRemovedInMigration}', "taxAmount"::text::jsonb)
      WHERE "kind" = 'PLATFORM_TIP'
      AND "taxAmount" < 0
    `);
  },

  async down() {
    console.log('This migration can be reverted manually by looking at the data.taxAmountRemovedInMigration field.');
  },
};
