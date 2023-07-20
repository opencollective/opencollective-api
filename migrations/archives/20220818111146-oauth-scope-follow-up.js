'use strict';

import { updateEnum } from './lib/helpers';

const previousScopes = [
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
];

const updatedScopes = [
  'email',
  'incognito',
  'account',
  'expenses',
  'orders',
  'transactions',
  'virtualCards',
  'host',
  'root',
  'conversations',
  'updates',
  'webhooks',
  'applications',
  'connectedAccounts',
  'activities',
];

module.exports = {
  up: async queryInterface => {
    await updateEnum(
      queryInterface,
      'OAuthAuthorizationCodes',
      'scope',
      'enum_OAuthAuthorizationCodes_scope',
      updatedScopes,
    );
    await updateEnum(queryInterface, 'UserTokens', 'scope', 'enum_UserTokens_scope', updatedScopes);
  },

  down: async queryInterface => {
    await updateEnum(
      queryInterface,
      'OAuthAuthorizationCodes',
      'scope',
      'enum_OAuthAuthorizationCodes_scope',
      previousScopes,
    );
    await updateEnum(queryInterface, 'UserTokens', 'scope', 'enum_UserTokens_scope', previousScopes);
  },
};
