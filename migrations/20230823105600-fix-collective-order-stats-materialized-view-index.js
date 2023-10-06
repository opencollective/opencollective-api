'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "collective_order_stats__collectiveid";`);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX "collective_order_stats__collectiveid" ON "CollectiveOrderStats"("CollectiveId");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "collective_order_stats__collectiveid";`);
    await queryInterface.sequelize.query(`
      CREATE INDEX "collective_order_stats__collectiveid" ON "CollectiveOrderStats"("CollectiveId");
    `);
  },
};
