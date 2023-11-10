'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
     UPDATE "Transactions"
     SET "deletedAt" = NOW()
     WHERE "kind" = 'PAYMENT_PROCESSOR_COVER'
     AND "HostCollectiveId" = "CollectiveId"
     AND "HostCollectiveId" = "FromCollectiveId"
     AND "deletedAt" IS NULL
    `);
  },

  async down() {},
};
