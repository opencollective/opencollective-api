import { GraphQLObjectType } from 'graphql';

import { Account, AccountFields } from '../interface/Account';

export const Fund = new GraphQLObjectType({
  name: 'Fund',
  description: 'This represents an Project account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === 'FUND',
  fields: () => {
    return {
      ...AccountFields,
    };
  },
});
