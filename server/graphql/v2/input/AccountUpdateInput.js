import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLCurrency } from '../enum/Currency';

export const GraphQLAccountUpdateInput = new GraphQLInputObjectType({
  name: 'AccountUpdateInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id identifying the account (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    currency: { type: GraphQLCurrency },
    hostFeePercent: {
      type: GraphQLInt,
      description: 'The host fee percentage for this account. Must be between 0 and 100.',
    },
    settings: {
      type: new GraphQLInputObjectType({
        name: 'AccountUpdateSettingsInput',
        fields: () => ({
          apply: {
            type: GraphQLBoolean,
            description: 'Whether this host account is accepting fiscal sponsorship applications.',
          },
          applyMessage: {
            type: GraphQLString,
            description: 'Message shown to users when applying to join this account.',
          },
          tos: { type: GraphQLString, description: 'Terms of Service for this account.' },
        }),
      }),
      description: 'Settings for the account.',
    },
  }),
});
