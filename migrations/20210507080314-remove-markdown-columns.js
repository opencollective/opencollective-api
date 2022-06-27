'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.removeColumn('Comments', 'markdown');
    await queryInterface.removeColumn('UpdateHistories', 'markdown');
    await queryInterface.removeColumn('Updates', 'markdown');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Comments', 'markdown', { type: Sequelize.TEXT });
    await queryInterface.addColumn('UpdateHistories', 'markdown', { type: Sequelize.TEXT });
    await queryInterface.addColumn('Updates', 'markdown', { type: Sequelize.TEXT });
  },
};
