'use strict';

module.exports = {
  up: async function (queryInterface, DataTypes) {
    await queryInterface.changeColumn('Expenses', 'privateMessage', {
      type: DataTypes.TEXT,
    });
    await queryInterface.changeColumn('ExpenseHistories', 'privateMessage', {
      type: DataTypes.TEXT,
    });
    await queryInterface.changeColumn('ExpenseItems', 'description', {
      type: DataTypes.TEXT,
    });
  },

  down: async function (queryInterface, DataTypes) {
    await queryInterface.changeColumn('Expenses', 'privateMessage', {
      type: DataTypes.STRING,
    });
    await queryInterface.changeColumn('ExpenseHistories', 'privateMessage', {
      type: DataTypes.STRING,
    });
    await queryInterface.changeColumn('ExpenseItems', 'description', {
      type: DataTypes.STRING,
    });
  },
};
