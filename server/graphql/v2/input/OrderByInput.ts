import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { ORDER_BY_PSEUDO_FIELDS, OrderByFieldType } from '../enum/OrderByFieldType';
import { OrderDirectionType } from '../enum/OrderDirectionType';

export { ORDER_BY_PSEUDO_FIELDS };

export const OrderByInput = new GraphQLInputObjectType({
  name: 'OrderByInput',
  description: 'Input to order results',
  fields: () => ({
    field: {
      description: 'Field to order by.',
      type: new GraphQLNonNull(OrderByFieldType),
    },
    direction: {
      description: 'Ordering direction.',
      type: new GraphQLNonNull(OrderDirectionType),
    },
  }),
});
