import { GraphQLObjectType, GraphQLString } from 'graphql';

import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';

import { Host } from './Host';

export const Organization = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents an Organization account',
  interfaces: () => [Account, AccountWithContributions],
  isTypeOf: collective => collective.type === 'ORGANIZATION',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      email: {
        type: GraphQLString,
        deprecationReason: '2022-07-18: This field is deprecated and will return null',
        resolve: () => null,
      },
      host: {
        type: Host,
        description: 'If the organization is a host account, this will return the matching Host object',
        resolve(collective) {
          if (collective.isHostAccount) {
            return collective;
          }
        },
      },
    };
  },
});
