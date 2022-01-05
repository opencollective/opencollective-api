'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Orders', 'platformTipAmount', { type: Sequelize.INTEGER, defaultValue: 0 });
    await queryInterface.addColumn('OrderHistories', 'platformTipAmount', { type: Sequelize.INTEGER, defaultValue: 0 });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Orders', 'platformTipAmount');
    await queryInterface.removeColumn('OrderHistories', 'platformTipAmount');
  },
};
