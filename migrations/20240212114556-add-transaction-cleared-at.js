'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Transactions', 'clearedAt', { type: Sequelize.DATE });

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__collective_clearedAt"
      ON "Transactions"("CollectiveId", "clearedAt" DESC)
      WHERE "deletedAt" IS NULL
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__hostCollective_clearedAt"
      ON "Transactions"("HostCollectiveId", "clearedAt" DESC)
      WHERE "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__collective_clearedAt", "transactions__hostCollective_clearedAt";
    `);

    await queryInterface.removeColumn('Transactions', 'clearedAt');
  },
};
