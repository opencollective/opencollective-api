import { GraphQLEnumType } from 'graphql';

import oAuthScopes from '../../../constants/oauth-scopes';

export const OAuthScope = new GraphQLEnumType({
  name: 'OAuthScope',
  description: 'All supported OAuth scopes',
  values: {
    [oAuthScopes.email]: {
      description: 'email: Access your email address.',
    },
    [oAuthScopes.incognito]: {
      description: 'incognito: Access your incognito account.',
    },
    [oAuthScopes.account]: {
      description: 'account: Manage your account, collectives and organizations.',
    },
    [oAuthScopes.expenses]: {
      description: 'expenses: Create and manage expenses, payout methods.',
    },
    [oAuthScopes.orders]: {
      description: 'orders: Create and manage contributions, payment methods.',
    },
    [oAuthScopes.transactions]: {
      description: 'transactions: Refund and reject recorded transactions.',
    },
    [oAuthScopes.virtualCards]: {
      description: 'virtualCards: Create and manage virtual cards.',
    },
    [oAuthScopes.updates]: {
      description: 'updates: Create and manage updates.',
    },
    [oAuthScopes.conversations]: {
      description: 'conversations: Create and manage conversations.',
    },
    [oAuthScopes.webhooks]: {
      description: 'webhooks: Create and manage webhooks',
    },
    [oAuthScopes.host]: {
      description: 'host: Administrate fiscal hosts.',
    },
    [oAuthScopes.applications]: {
      description: 'applications: Create and manage OAuth applications.',
    },
    [oAuthScopes.connectedAccounts]: {
      description: 'connectedAccounts: Create and manage connected accounts.',
    },
    [oAuthScopes.root]: {
      description: 'root: Perform critical administrative operations. ',
    },
  },
});
