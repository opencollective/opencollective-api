import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import ORDER_STATUS from '../../../constants/order-status';
import { checkReceiveFinancialContributions } from '../../common/features';
import * as OrdersLib from '../../common/orders';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

const GraphQLOrderPermissions = new GraphQLObjectType({
  name: 'OrderPermissions',
  description: 'Fields for the user permissions on an order',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ORDER),
    },
    canMarkAsExpired: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this order as expired',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return OrdersLib.canMarkAsExpired(req, order);
      },
    },
    canMarkAsPaid: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this order as unpaid',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return OrdersLib.canMarkAsPaid(req, order);
      },
    },
    canEdit: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit this pending order',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return OrdersLib.canEdit(req, order);
      },
    },
    canComment: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can comment on this order',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return OrdersLib.canComment(req, order);
      },
    },
    canSeePrivateActivities: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can see private activities for this order',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return OrdersLib.canSeeOrderPrivateActivities(req, order);
      },
    },
    canSetTags: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can set tags on this order',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return OrdersLib.canSetOrderTags(req, order);
      },
    },
    canUpdateAccountingCategory: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can update the accounting category of this order',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return OrdersLib.isOrderHostAdmin(req, order);
      },
    },
    canResume: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'If paused, whether the current user can resume this order',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        if (
          !req.remoteUser ||
          order.status !== ORDER_STATUS.PAUSED ||
          order.data?.needsAsyncDeactivation ||
          order.data?.needsAsyncPause ||
          order.data?.needsAsyncReactivation ||
          ['HOST', 'PLATFORM'].includes(order.data?.pausedBy)
        ) {
          return false;
        }

        const collective = await req.loaders.Collective.byId.load(order.CollectiveId);
        if (!['AVAILABLE', 'ACTIVE'].includes(await checkReceiveFinancialContributions(collective, req))) {
          return false;
        }

        return req.remoteUser.isAdmin(order.FromCollectiveId);
      },
    },
  }),
});

export default GraphQLOrderPermissions;
