'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transferwise_transfer_id ON "Transactions" (((data -> 'transfer' ->> 'id')::text)) WHERE (data -> 'transfer' ->> 'id') IS NOT NULL;
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS transferwise_transfer_id;
    `);
  },
};
