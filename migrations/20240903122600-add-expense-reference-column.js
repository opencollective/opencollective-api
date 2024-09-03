'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Expenses', 'reference', {
      type: Sequelize.STRING,
    });

    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "expense__reference" ON "Expenses" (reference) WHERE "deletedAt" IS NULL;`,
    );

    await queryInterface.addColumn('ExpenseHistories', 'reference', {
      type: Sequelize.STRING,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Expenses', 'reference');
    await queryInterface.removeColumn('ExpenseHistories', 'reference');
  },
};
