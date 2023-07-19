import { GraphQLObjectType } from 'graphql';

import { AccountFields, GraphQLAccount } from '../interface/Account.js';
import {
  AccountWithContributionsFields,
  GraphQLAccountWithContributions,
} from '../interface/AccountWithContributions.js';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost.js';

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
