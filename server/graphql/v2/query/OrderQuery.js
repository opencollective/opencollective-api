import { GraphQLNonNull } from 'graphql';

import { fetchOrderWithReference, GraphQLOrderReferenceInput } from '../input/OrderReferenceInput';
import { GraphQLOrder } from '../object/Order';

const OrderQuery = {
  type: GraphQLOrder,
  args: {
    order: {
      type: new GraphQLNonNull(GraphQLOrderReferenceInput),
      description: 'Identifiers to retrieve the Order',
    },
  },
  async resolve(_, args, req) {
    return fetchOrderWithReference(args.order, { loaders: req.loaders });
  },
};

export default OrderQuery;
