'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('VirtualCards', 'provider', { type: Sequelize.ENUM('STRIPE', 'PRIVACY') });

    await queryInterface.sequelize.query(
      `
        UPDATE
          "VirtualCards"
        SET
          "provider" = 'PRIVACY'
      `,
    );
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('VirtualCards', 'provider');
  },
};
