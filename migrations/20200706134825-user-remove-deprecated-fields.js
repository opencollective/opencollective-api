'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Users', '_salt');
    await queryInterface.removeColumn('Users', 'refresh_token');
    await queryInterface.removeColumn('Users', 'password_hash');
    await queryInterface.removeColumn('Users', 'resetPasswordTokenHash');
    await queryInterface.removeColumn('Users', 'resetPasswordSentAt');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Users', '_salt', { type: Sequelize.STRING });
    await queryInterface.addColumn('Users', 'refresh_token', { type: Sequelize.STRING });
    await queryInterface.addColumn('Users', 'password_hash', { type: Sequelize.STRING });
    await queryInterface.addColumn('Users', 'resetPasswordTokenHash', { type: Sequelize.STRING });
    await queryInterface.addColumn('Users', 'resetPasswordSentAt', { type: Sequelize.DATE });
  },
};
