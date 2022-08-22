'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const colSettings = { type: Sequelize.ARRAY(Sequelize.STRING), allowNull: true };
    await queryInterface.addColumn('OrderHistories', 'tags', colSettings);
    await queryInterface.addColumn('Orders', 'tags', colSettings);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Orders', 'tags');
    await queryInterface.removeColumn('OrderHistories', 'tags');
  },
};
