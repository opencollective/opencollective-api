'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Tiers', 'maxQuantityPerUser');
    await queryInterface.removeColumn('TierHistories', 'maxQuantityPerUser');
    await queryInterface.removeColumn('Tiers', 'password');
    await queryInterface.removeColumn('TierHistories', 'password');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Tiers', 'maxQuantityPerUser', { type: Sequelize.INTEGER });
    await queryInterface.addColumn('TierHistories', 'maxQuantityPerUser', { type: Sequelize.INTEGER });
    await queryInterface.addColumn('Tiers', 'password', { type: Sequelize.STRING });
    await queryInterface.addColumn('TierHistories', 'password', { type: Sequelize.STRING });
  },
};
