import { GraphQLObjectType } from 'graphql';

import { types as collectiveTypes } from '../../../constants/collectives.js';
import { AccountFields, GraphQLAccount } from '../interface/Account.js';
import {
  AccountWithContributionsFields,
  GraphQLAccountWithContributions,
} from '../interface/AccountWithContributions.js';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost.js';

export const GraphQLCollective = new GraphQLObjectType({
  name: 'Collective',
  description: 'This represents a Collective account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === collectiveTypes.COLLECTIVE,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
    };
  },
});
