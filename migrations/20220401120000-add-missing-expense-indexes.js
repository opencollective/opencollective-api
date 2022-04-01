'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS expenses_collective_id ON public."Expenses" USING btree ("CollectiveId", "deletedAt");
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS expenses_from_collective_id ON public."Expenses" USING btree ("FromCollectiveId", "deletedAt"); 
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS expenses_collective_id;
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS expenses_from_collective_id;
    `);
  },
};
