'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Collectives', 'platformFeePercent', {
      type: Sequelize.FLOAT,
    });
    await queryInterface.addColumn('CollectiveHistories', 'platformFeePercent', {
      type: Sequelize.FLOAT,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Collectives', 'platformFeePercent');
    await queryInterface.removeColumn('CollectiveHistories', 'platformFeePercent');
  },
};
