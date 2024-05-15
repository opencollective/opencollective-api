'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_isPendingContribution" ON "Orders" (((data #>> '{isPendingContribution}')::text)) where ((data #>> '{isPendingContribution}'::text[]) = 'true'::text);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_isManualContribution" ON "Orders" (((data #>> '{isManualContribution}')::text)) where ((data #>> '{isManualContribution}'::text[]) = 'true'::text);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "orders_isPendingContribution";
    `);

    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "orders_isManualContribution";
    `);
  },
};
