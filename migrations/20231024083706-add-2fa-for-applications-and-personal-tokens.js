'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Applications', 'preAuthorize2FA', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });
    await queryInterface.addColumn('UserTokens', 'preAuthorize2FA', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });
    await queryInterface.addColumn('PersonalTokens', 'preAuthorize2FA', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Applications', 'preAuthorize2FA');
    await queryInterface.removeColumn('UserTokens', 'preAuthorize2FA');
    await queryInterface.removeColumn('PersonalTokens', 'preAuthorize2FA');
  },
};
