'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders__req_ip"
      ON "Orders" USING HASH ((data#>>'{reqIp}'))
      WHERE data#>>'{reqIp}' IS NOT NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "orders__req_ip"
    `);
  },
};
