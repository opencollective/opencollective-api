import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import ORDER_STATUS from '../../../constants/order_status';

const isHostAdmin = async (req, order) => {
  if (!req.remoteUser) {
    return false;
  }

  const toAccount = await req.loaders.Collective.byId.load(order.CollectiveId);
  return req.remoteUser.isAdmin(toAccount.HostCollectiveId);
};

const OrderPermissions = new GraphQLObjectType({
  name: 'OrderPermissions',
  description: 'Fields for the user permissions on an order',
  fields: () => ({
    canMarkAsExpired: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this order as expired',
      async resolve(order, _, req): Promise<boolean> {
        return order.status === ORDER_STATUS.PENDING && isHostAdmin(req, order);
      },
    },
    canMarkAsPaid: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this order as unpaid',
      async resolve(order, _, req): Promise<boolean> {
        return order.status === ORDER_STATUS.PENDING && isHostAdmin(req, order);
      },
    },
  }),
});

export default OrderPermissions;
