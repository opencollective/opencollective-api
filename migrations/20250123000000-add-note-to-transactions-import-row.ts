'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('TransactionsImportsRows', 'note', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('TransactionsImportsRows', 'note');
  },
};
