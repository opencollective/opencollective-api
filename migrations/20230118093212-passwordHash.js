'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Users', 'passwordHash', { type: Sequelize.STRING });
    await queryInterface.addColumn('UserHistories', 'passwordHash', { type: Sequelize.STRING });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Users', 'passwordHash');
    await queryInterface.removeColumn('UserHistories', 'passwordHash');
  },
};
