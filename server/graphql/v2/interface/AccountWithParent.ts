import { GraphQLInterfaceType } from 'graphql';

import { types as COLLECTIVE_TYPE } from '../../../constants/collectives';
import models from '../../../models';
import { Event } from '../object/Event';
import { Project } from '../object/Project';

import { Account } from './Account';

export const AccountWithParentFields = {
  parent: {
    description: 'The Account parenting this account',
    type: Account,
    async resolve(account, _, req): Promise<typeof models.Collective | null> {
      if (!account.ParentCollectiveId) {
        return null;
      } else {
        return req.loaders.Collective.byId.load(account.ParentCollectiveId);
      }
    },
  },
};

export const AccountWithParent = new GraphQLInterfaceType({
  name: 'AccountWithParent',
  description: 'An account that has a parent account',
  fields: () => AccountWithParentFields,
  resolveType: collective => {
    switch (collective.type) {
      case COLLECTIVE_TYPE.PROJECT:
        return Project;
      case COLLECTIVE_TYPE.EVENT:
        return Event;
      default:
        return null;
    }
  },
});
