'use strict';

module.exports = {
  async up(queryInterface) {
    // Rename `token` to `accessToken`
    await queryInterface.renameColumn('UserTokens', 'token', 'accessToken');
    await queryInterface.renameColumn('UserTokens', 'expiresAt', 'accessTokenExpiresAt');

    // Add index on `refreshToken`
    await queryInterface.addIndex('UserTokens', ['refreshToken'], { unique: true });
  },

  async down(queryInterface) {
    await queryInterface.renameColumn('UserTokens', 'accessToken', 'token');
    await queryInterface.removeIndex('UserTokens', ['refreshToken']);
  },
};
