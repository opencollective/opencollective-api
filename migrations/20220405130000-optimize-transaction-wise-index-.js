'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transferwise_transfer_id";
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transaction_wise_transfer_id" ON "Transactions" USING BTREE ((data#>>'{transfer,id}') DESC) WHERE data#>>'{transfer,id}' IS NOT NULL; 
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transaction_wise_transfer_id";
    `);
  },
};
