import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import ORDER_STATUS from '../../../constants/order_status';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

const isHostAdmin = async (req: express.Request, order): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const toAccount = await req.loaders.Collective.byId.load(order.CollectiveId);
  return req.remoteUser.isAdmin(toAccount.HostCollectiveId);
};

export const canMarkAsPaid = async (req: express.Request, order): Promise<boolean> => {
  const allowedStatuses = [ORDER_STATUS.PENDING, ORDER_STATUS.EXPIRED];
  return allowedStatuses.includes(order.status) && isHostAdmin(req, order);
};

export const canMarkAsExpired = async (req: express.Request, order): Promise<boolean> => {
  return order.status === ORDER_STATUS.PENDING && isHostAdmin(req, order);
};

export const canEdit = async (req: express.Request, order): Promise<boolean> => {
  return order.status === ORDER_STATUS.PENDING && isHostAdmin(req, order);
};

const OrderPermissions = new GraphQLObjectType({
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
        return canMarkAsExpired(req, order);
      },
    },
    canMarkAsPaid: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this order as unpaid',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return canMarkAsPaid(req, order);
      },
    },
    canEdit: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user edit this pending order',
      async resolve(order, _, req: express.Request): Promise<boolean> {
        return canEdit(req, order);
      },
    },
  }),
});

export default OrderPermissions;
