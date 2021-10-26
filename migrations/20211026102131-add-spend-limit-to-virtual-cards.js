'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('VirtualCards', 'spendingLimitAmount', { type: Sequelize.INTEGER });
    await queryInterface.addColumn('VirtualCards', 'spendingLimitInterval', { type: Sequelize.STRING });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('VirtualCards', 'spendingLimitAmount');
    await queryInterface.removeColumn('VirtualCards', 'spendingLimitInterval');
  },
};
