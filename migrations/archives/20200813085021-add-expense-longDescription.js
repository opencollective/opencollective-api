'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Expenses', 'longDescription', {
      type: Sequelize.TEXT,
    });
    await queryInterface.addColumn('ExpenseHistories', 'longDescription', {
      type: Sequelize.TEXT,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Expenses', 'longDescription');
    await queryInterface.removeColumn('ExpenseHistories', 'longDescription');
  },
};
