'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('OAuthAuthorizationCodes', 'scope', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('UserTokens', 'scope', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('OAuthAuthorizationCodes', 'scope');
    await queryInterface.removeColumn('UserTokens', 'scope');
  },
};
