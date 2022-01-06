'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Orders', 'platformTipAmount', { type: Sequelize.INTEGER, defaultValue: 0 });
    await queryInterface.addColumn('OrderHistories', 'platformTipAmount', { type: Sequelize.INTEGER, defaultValue: 0 });
    await queryInterface.addColumn('Orders', 'platformTipEligible', { type: Sequelize.BOOLEAN, defaultValue: false });
    await queryInterface.addColumn('OrderHistories', 'platformTipEligible', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Orders', 'platformTipAmount');
    await queryInterface.removeColumn('OrderHistories', 'platformTipAmount');
    await queryInterface.removeColumn('Orders', 'platformTipEligible');
    await queryInterface.removeColumn('OrderHistories', 'platformTipEligible');
  },
};
