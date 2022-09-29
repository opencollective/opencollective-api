'use strict';

module.exports = {
  async up(queryInterface) {
    // FromCollectiveId
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities__from_collective_id_simple"
      ON "Activities"("FromCollectiveId")
      WHERE "FromCollectiveId" IS NOT NULL
      AND "type" NOT IN ('collective.transaction.created')
    `);

    // CollectiveId
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities__collective_id_simple"
      ON "Activities"("CollectiveId")
      WHERE "CollectiveId" IS NOT NULL
      AND "type" NOT IN ('collective.transaction.created')
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "activities__from_collective_id_simple";
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "activities__collective_id_simple";
    `);
  },
};
