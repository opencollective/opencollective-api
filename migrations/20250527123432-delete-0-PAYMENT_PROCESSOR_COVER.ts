'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "deletedAt" = NOW()
      WHERE "amountInHostCurrency" = 0
      AND "deletedAt" IS NULL
      AND "kind" = 'PAYMENT_PROCESSOR_COVER'
    `);
  },

  async down() {
    console.log('Manual rollback needed');
  },
};
