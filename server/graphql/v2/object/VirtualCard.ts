import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSONObject } from 'graphql-type-json';

import { checkScope } from '../../common/scope-check';
import { Currency } from '../enum/Currency';
import { Account } from '../interface/Account';
import { Individual } from '../object/Individual';

export const VirtualCard = new GraphQLObjectType({
  name: 'VirtualCard',
  description: 'A Virtual Card used to pay expenses',
  fields: () => ({
    id: { type: GraphQLString },
    account: {
      type: Account,
      resolve(virtualCard, _, req) {
        if (virtualCard.CollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        }
      },
    },
    host: {
      type: Account,
      resolve(virtualCard, _, req) {
        if (virtualCard.HostCollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.HostCollectiveId);
        }
      },
    },
    assignee: {
      type: Individual,
      async resolve(virtualCard, _, req) {
        if (!virtualCard.UserId) {
          return null;
        }

        const user = await req.loaders.User.byId.load(virtualCard.UserId);
        if (user && user.CollectiveId) {
          const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
          if (collective && !collective.isIncognito) {
            return collective;
          }
        }
      },
    },
    name: {
      type: GraphQLString,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards')) {
          return virtualCard.name;
        }
      },
    },
    last4: {
      type: GraphQLString,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards')) {
          return virtualCard.last4;
        }
      },
    },
    data: {
      type: GraphQLJSONObject,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards')) {
          return virtualCard.data;
        }
      },
    },
    privateData: {
      type: GraphQLJSONObject,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards')) {
          return virtualCard.get('privateData');
        }
      },
    },
    provider: { type: GraphQLString },
    spendingLimitAmount: {
      type: GraphQLInt,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards')) {
          return virtualCard.spendingLimitAmount;
        }
      },
    },
    spendingLimitInterval: {
      type: GraphQLString,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards')) {
          return virtualCard.spendingLimitInterval;
        }
      },
    },
    currency: { type: Currency },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
