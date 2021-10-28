'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('VirtualCards', 'provider', { type: Sequelize.ENUM('stripe', 'privacy') });

    await queryInterface.sequelize.query(
      `
        UPDATE
          "VirtualCards"
        SET
          "provider" = 'privacy'
      `,
    );
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('VirtualCards', 'provider');
  },
};
