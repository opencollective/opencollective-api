'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses__wise_transfer_id" ON "Expenses" USING BTREE ((data#>>'{transfer,id}') DESC) WHERE data#>>'{transfer,id}' IS NOT NULL; 
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS expenses__wise_transfer_id;
    `);
  },
};
