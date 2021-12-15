import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { GraphQLJSONObject } from 'graphql-type-json';

import { Currency } from '../enum/Currency';
import { Account } from '../interface/Account';
import { Individual } from '../object/Individual';

export const VirtualCard = new GraphQLObjectType({
  name: 'VirtualCard',
  description: 'VirtualCard related properties.',
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
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.name;
        }
      },
    },
    last4: {
      type: GraphQLString,

      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.last4;
        }
      },
    },
    data: {
      type: GraphQLJSONObject,
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.data;
        }
      },
    },
    privateData: {
      type: GraphQLJSONObject,
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.get('privateData');
        }
      },
    },
    provider: { type: GraphQLString },
    spendingLimitAmount: {
      type: GraphQLInt,
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.spendingLimitAmount;
        }
      },
    },
    spendingLimitInterval: {
      type: GraphQLString,
      resolve(virtualCard, _, req) {
        if (
          req.remoteUser?.isAdmin(virtualCard.CollectiveId) ||
          req.remoteUser?.isAdmin(virtualCard.HostCollectiveId)
        ) {
          return virtualCard.spendingLimitInterval;
        }
      },
    },
    currency: { type: Currency },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
