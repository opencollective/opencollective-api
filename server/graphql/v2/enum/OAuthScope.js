import { GraphQLEnumType } from 'graphql';

import oAuthScopes from '../../../constants/oauth-scopes.js';

export const GraphQLOAuthScope = new GraphQLEnumType({
  name: 'OAuthScope',
  description: 'All supported OAuth scopes',
  values: {
    [oAuthScopes.email]: {
      description: 'Access your email address.',
    },
    [oAuthScopes.incognito]: {
      description: 'Access your incognito account.',
    },
    [oAuthScopes.account]: {
      description: 'Manage your account, collectives and organizations.',
    },
    [oAuthScopes.expenses]: {
      description: 'Create and manage expenses, payout methods.',
    },
    [oAuthScopes.orders]: {
      description: 'Create and manage contributions, payment methods.',
    },
    [oAuthScopes.transactions]: {
      description: 'Refund and reject recorded transactions.',
    },
    [oAuthScopes.virtualCards]: {
      description: 'Create and manage virtual cards.',
    },
    [oAuthScopes.updates]: {
      description: 'Create and manage updates.',
    },
    [oAuthScopes.conversations]: {
      description: 'Create and manage conversations.',
    },
    [oAuthScopes.webhooks]: {
      description: 'Create and manage webhooks',
    },
    [oAuthScopes.host]: {
      description: 'Administrate fiscal hosts.',
    },
    [oAuthScopes.applications]: {
      description: 'Create and manage OAuth applications.',
    },
    [oAuthScopes.connectedAccounts]: {
      description: 'Create and manage connected accounts.',
    },
    [oAuthScopes.root]: {
      description: 'Perform critical administrative operations. ',
    },
  },
});
