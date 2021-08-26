'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const fieldSettings = { type: Sequelize.STRING, allowNull: true };
    await queryInterface.addColumn('CollectiveHistories', 'legalName', fieldSettings);
    await queryInterface.addColumn('Collectives', 'legalName', fieldSettings);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('CollectiveHistories', 'legalName');
    await queryInterface.removeColumn('Collectives', 'legalName');
  },
};
