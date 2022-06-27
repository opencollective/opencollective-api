import { GraphQLObjectType } from 'graphql';

import { types as collectiveTypes } from '../../../constants/collectives';
import { Account, AccountFields } from '../interface/Account';
import { AccountWithContributions, AccountWithContributionsFields } from '../interface/AccountWithContributions';
import { AccountWithHost, AccountWithHostFields } from '../interface/AccountWithHost';

export const Vendor = new GraphQLObjectType({
  name: 'Vendor',
  description: 'This represents a Vendor account',
  interfaces: () => [Account, AccountWithHost, AccountWithContributions],
  isTypeOf: collective => collective.type === collectiveTypes.VENDOR,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithContributionsFields,
    };
  },
});
