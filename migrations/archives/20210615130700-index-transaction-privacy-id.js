'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY privacy_transfer_id ON "Transactions" (((data ->> 'token')::text)) WHERE (data ->> 'token') IS NOT NULL;
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS privacy_transfer_id;
    `);
  },
};
