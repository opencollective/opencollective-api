'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('VirtualCards', 'currency', { type: Sequelize.STRING });

    await queryInterface.sequelize.query(
      `
        UPDATE
          "VirtualCards"
        SET
          "currency" = 'USD'
      `,
    );
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('VirtualCards', 'currency');
  },
};
