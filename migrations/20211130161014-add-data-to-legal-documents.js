'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('LegalDocuments', 'data', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('LegalDocuments', 'data');
  },
};
