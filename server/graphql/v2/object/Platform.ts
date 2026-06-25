import { GraphQLObjectType } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithHostFields, GraphQLAccountWithHost } from '../interface/AccountWithHost';
import { AccountWithParentFields, GraphQLAccountWithParent } from '../interface/AccountWithParent';

export const GraphQLPlatform = new GraphQLObjectType({
  name: 'Platform',
  description:
    'This represents a Platform account: a per-host account (a hosted child of the fiscal host) that holds platform tips collected on behalf of the Open Collective platform.',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithHost, GraphQLAccountWithParent],
  isTypeOf: collective => collective.type === CollectiveType.PLATFORM,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithHostFields,
      ...AccountWithParentFields,
    };
  },
});
