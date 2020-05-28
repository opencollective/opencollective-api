'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Expenses', 'data', { type: Sequelize.JSONB });
    await queryInterface.addColumn('ExpenseHistories', 'data', { type: Sequelize.JSONB });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Expenses', 'data');
    await queryInterface.removeColumn('ExpenseHistories', 'data');
  },
};
