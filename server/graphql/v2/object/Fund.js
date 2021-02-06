import { GraphQLObjectType } from 'graphql';

import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { AccountWithHost, AccountWithHostFields } from '../interface/AccountWithHost';

export const Fund = new GraphQLObjectType({
  name: 'Fund',
  description: 'This represents an Project account',
  interfaces: () => [Account, AccountWithHost, AccountWithContributions],
  isTypeOf: collective => collective.type === 'FUND',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
    };
  },
});
