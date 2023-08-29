import { GraphQLInterfaceType } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';
import { Collective } from '../../../models';

import { GraphQLAccount } from './Account';

export const AccountWithParentFields = {
  parent: {
    description: 'The Account parenting this account',
    type: GraphQLAccount,
    async resolve(account, _, req): Promise<Collective | null> {
      if (!account.ParentCollectiveId) {
        return null;
      } else {
        return req.loaders.Collective.byId.load(account.ParentCollectiveId);
      }
    },
  },
};

export const GraphQLAccountWithParent = new GraphQLInterfaceType({
  name: 'AccountWithParent',
  description: 'An account that has a parent account',
  fields: () => AccountWithParentFields,
  resolveType: collective => {
    switch (collective.type) {
      case CollectiveType.PROJECT:
        return 'Project';
      case CollectiveType.EVENT:
        return 'Event';
      default:
        return null;
    }
  },
});
