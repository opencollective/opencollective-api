'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY wise_batchgroup_id ON "Expenses" (((data #>> '{batchGroup,id}')::text)) WHERE (data #>> '{batchGroup,id}') IS NOT NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY wise_batchgroup_status ON "Expenses" (((data #>> '{batchGroup,status}')::text)) WHERE (data #>> '{batchGroup,status}') IS NOT NULL;
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS wise_batchgroup_id;
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS wise_batchgroup_status;
    `);
  },
};
