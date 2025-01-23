'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__contributions_fromcollective_to_host
        ON "Transactions" ("HostCollectiveId", "FromCollectiveId", "createdAt")
        WHERE ("deletedAt" IS NULL AND "kind" = 'CONTRIBUTION' AND "RefundTransactionId" IS NULL);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY transactions__contributions_fromcollective_to_host;
    `);
  },
};
