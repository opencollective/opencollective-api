import { GraphQLObjectType } from 'graphql';

import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost';

export const GraphQLFund = new GraphQLObjectType({
  name: 'Fund',
  description: 'This represents an Project account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === 'FUND',
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
    };
  },
});
