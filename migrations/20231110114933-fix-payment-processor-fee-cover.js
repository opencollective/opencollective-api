'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
     UPDATE "Transactions"
     SET "deletedAt" = NOW(), "data" = jsonb_set(COALESCE("data", '{}'), '{deletedFromMigration20231110114933}', 'true')
     WHERE "kind" = 'PAYMENT_PROCESSOR_COVER'
     AND "HostCollectiveId" = "CollectiveId"
     AND "HostCollectiveId" = "FromCollectiveId"
     AND "deletedAt" IS NULL
    `);
  },

  async down() {},
};
