'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('OAuthAuthorizationCodes', 'scope', {
      type: Sequelize.ARRAY(
        Sequelize.ENUM(
          'email',
          'account',
          'expenses',
          'orders',
          'transactions',
          'virtualCards',
          'payoutMethods',
          'paymentMethods',
          'host',
          'root',
          'conversations',
          'updates',
          'webhooks',
          'applications',
          'connectedAccounts',
        ),
      ),
      allowNull: true,
    });
    await queryInterface.addColumn('UserTokens', 'scope', {
      type: Sequelize.ARRAY(
        Sequelize.ENUM(
          'email',
          'account',
          'expenses',
          'orders',
          'transactions',
          'virtualCards',
          'payoutMethods',
          'paymentMethods',
          'host',
          'root',
          'conversations',
          'updates',
          'webhooks',
          'applications',
          'connectedAccounts',
        ),
      ),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('OAuthAuthorizationCodes', 'scope');
    await queryInterface.removeColumn('UserTokens', 'scope');
  },
};
