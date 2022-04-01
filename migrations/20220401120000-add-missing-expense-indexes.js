'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS expenses_collective_id ON public."Expenses" USING btree ("CollectiveId") WHERE "deletedAt" IS NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS expenses_from_collective_id ON public."Expenses" USING btree ("FromCollectiveId") WHERE "deletedAt" IS NULL; 
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
