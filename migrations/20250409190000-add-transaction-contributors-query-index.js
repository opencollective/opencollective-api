'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__ContributorsQuery"
      ON "Transactions" ("CollectiveId", "FromCollectiveId", "UsingGiftCardFromCollectiveId")
      WHERE type = 'CREDIT' AND kind NOT IN ('HOST_FEE', 'HOST_FEE_SHARE', 'HOST_FEE_SHARE_DEBT', 'PLATFORM_TIP_DEBT') AND "deletedAt" IS NULL AND "RefundTransactionId" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "transactions__ContributorsQuery";
    `);
  },
};
