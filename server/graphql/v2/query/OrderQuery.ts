import express from 'express';
import { GraphQLNonNull } from 'graphql';

import { Order } from '../../../models';
import { assertOrderAccessibleForPrivateCollective } from '../../common/orders';
import { enforceScope } from '../../common/scope-check';
import { fetchOrderWithReference, GraphQLOrderReferenceInput } from '../input/OrderReferenceInput';
import { GraphQLOrder } from '../object/Order';

const OrderQuery = {
  type: GraphQLOrder,
  description: 'Get an order by reference. Scope: "orders".',
  args: {
    order: {
      type: new GraphQLNonNull(GraphQLOrderReferenceInput),
      description: 'Identifiers to retrieve the Order',
    },
  },
  async resolve(_, args, req: express.Request): Promise<Order | null> {
    enforceScope(req, 'orders');
    const order = await fetchOrderWithReference(args.order, { loaders: req.loaders });
    await assertOrderAccessibleForPrivateCollective(req, order);
    return order;
  },
};

export default OrderQuery;
