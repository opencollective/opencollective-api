'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE INDEX "orders_paused_by"
      ON "Orders" ((data #>> '{pausedBy}'::text[]))
      WHERE ("deletedAt" IS NULL) AND ((data #>> '{pausedBy}'::text[]) IS NOT NULL);
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "orders_paused_by";
    `);
  },
};
