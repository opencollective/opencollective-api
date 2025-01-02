'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__unrefunded_credits
      ON "Transactions"("CollectiveId", kind, "createdAt")
      WHERE "deletedAt" IS NULL
      AND "type" = 'CREDIT'
      AND "RefundTransactionId" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__non_debt
      ON "Transactions"("HostCollectiveId", "CollectiveId", kind)
      WHERE "deletedAt" IS NULL AND "isDebt" = false;
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY transactions__unrefunded_credits;
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY transactions__non_debt;
    `);
  },
};
