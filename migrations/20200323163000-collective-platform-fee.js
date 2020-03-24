'use strict';

const OC_FEE_PERCENT = 5;

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Collectives', 'platformFeePercent', {
      type: Sequelize.INTEGER,
      defaultValue: OC_FEE_PERCENT,
    });
    await queryInterface.addColumn('CollectiveHistories', 'platformFeePercent', {
      type: Sequelize.INTEGER,
      defaultValue: OC_FEE_PERCENT,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Collectives', 'platformFeePercent');
    await queryInterface.removeColumn('CollectiveHistories', 'platformFeePercent');
  },
};
