import { GraphQLObjectType } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost';

export const GraphQLVendor = new GraphQLObjectType({
  name: 'Vendor',
  description: 'This represents a Vendor account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === CollectiveType.VENDOR,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
    };
  },
});
