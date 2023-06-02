import { GraphQLEnumType } from 'graphql';

import statuses from '../../../constants/order_status';

export const GraphQLOrderStatus = new GraphQLEnumType({
  name: 'OrderStatus',
  description: 'All order statuses',
  values: {
    ...Object.keys(statuses).reduce((values, status) => {
      values[status] = {};
      return values;
    }, {}),
  },
});
