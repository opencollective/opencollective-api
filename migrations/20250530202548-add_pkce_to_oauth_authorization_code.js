'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('OAuthAuthorizationCodes', 'codeChallenge', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    await queryInterface.addColumn('OAuthAuthorizationCodes', 'codeChallengeMethod', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('OAuthAuthorizationCodes', 'codeChallenge');
    await queryInterface.removeColumn('OAuthAuthorizationCodes', 'codeChallengeMethod');
  },
};
