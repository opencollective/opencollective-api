import { GraphQLObjectType } from 'graphql';

import { types as collectiveTypes } from '../../../constants/collectives.js';
import { AccountFields, GraphQLAccount } from '../interface/Account.js';
import {
  AccountWithContributionsFields,
  GraphQLAccountWithContributions,
} from '../interface/AccountWithContributions.js';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost.js';

export const GraphQLVendor = new GraphQLObjectType({
  name: 'Vendor',
  description: 'This represents a Vendor account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === collectiveTypes.VENDOR,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
    };
  },
});
