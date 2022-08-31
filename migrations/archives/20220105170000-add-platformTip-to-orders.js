'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Orders', 'platformTipAmount', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('OrderHistories', 'platformTipAmount', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('Orders', 'platformTipEligible', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('OrderHistories', 'platformTipEligible', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: null,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Orders', 'platformTipAmount');
    await queryInterface.removeColumn('OrderHistories', 'platformTipAmount');
    await queryInterface.removeColumn('Orders', 'platformTipEligible');
    await queryInterface.removeColumn('OrderHistories', 'platformTipEligible');
  },
};
