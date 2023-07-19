import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import VirtualCardRequest from '../../../models/VirtualCardRequest.js';
import { GraphQLCurrency } from '../enum/index.js';
import { GraphQLVirtualCardLimitInterval } from '../enum/VirtualCardLimitInterval.js';
import { GraphQLVirtualCardRequestStatus } from '../enum/VirtualCardRequestStatus.js';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers.js';
import GraphQLAccount from '../interface/Account.js';

import { GraphQLAmount } from './Amount.js';
import { GraphQLHost } from './Host.js';
import GraphQLIndividual from './Individual.js';

export const GraphQLVirtualCardRequest = new GraphQLObjectType({
  name: 'VirtualCardRequest',
  description: 'A Virtual Card request',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(virtualCardRequest: VirtualCardRequest) {
        return idEncode(virtualCardRequest.id, IDENTIFIER_TYPES.VIRTUAL_CARD_REQUEST);
      },
    },
    legacyId: {
      type: GraphQLInt,
      resolve(virtualCardRequest: VirtualCardRequest) {
        return virtualCardRequest.id;
      },
    },
    purpose: { type: GraphQLString },
    notes: {
      type: GraphQLString,
      async resolve(virtualCardRequest: VirtualCardRequest, _: void, req: Express.Request) {
        const collective =
          virtualCardRequest.collective || (await req.loaders.Collective.byId.load(virtualCardRequest.CollectiveId));
        if (!req.remoteUser.isAdminOfCollectiveOrHost(collective)) {
          return null;
        }

        return virtualCardRequest.notes;
      },
    },
    status: { type: GraphQLVirtualCardRequestStatus },
    currency: { type: GraphQLCurrency },
    spendingLimitAmount: {
      type: GraphQLAmount,
      resolve(virtualCardRequest: VirtualCardRequest) {
        return {
          currency: virtualCardRequest.currency,
          value: virtualCardRequest.spendingLimitAmount,
        };
      },
    },
    spendingLimitInterval: {
      type: GraphQLVirtualCardLimitInterval,
      resolve(virtualCardRequest: VirtualCardRequest) {
        return virtualCardRequest.spendingLimitInterval;
      },
    },
    assignee: {
      type: GraphQLIndividual,
      async resolve(virtualCardRequest: VirtualCardRequest, _, req) {
        if (!virtualCardRequest.UserId) {
          return null;
        }

        const user = virtualCardRequest.user || (await req.loaders.User.byId.load(virtualCardRequest.UserId));
        if (user && user.CollectiveId) {
          const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
          if (collective && !collective.isIncognito) {
            return collective;
          }
        }
      },
    },
    host: {
      type: GraphQLHost,
      resolve(virtualCardRequest: VirtualCardRequest, _, req) {
        if (virtualCardRequest.HostCollectiveId) {
          return virtualCardRequest.host || req.loaders.Collective.byId.load(virtualCardRequest.HostCollectiveId);
        }
      },
    },
    account: {
      type: GraphQLAccount,
      resolve(virtualCardRequest: VirtualCardRequest, _, req) {
        if (virtualCardRequest.CollectiveId) {
          return virtualCardRequest.collective || req.loaders.Collective.byId.load(virtualCardRequest.CollectiveId);
        }
      },
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
