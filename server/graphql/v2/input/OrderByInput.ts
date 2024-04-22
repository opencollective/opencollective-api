import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLOrderByFieldType, ORDER_BY_PSEUDO_FIELDS } from '../enum/OrderByFieldType';
import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';

export { ORDER_BY_PSEUDO_FIELDS };

export const GraphQLOrderByInput = new GraphQLInputObjectType({
  name: 'OrderByInput',
  description: 'Input to order collection',
  fields: () => ({
    field: {
      description: 'Field to order by.',
      type: new GraphQLNonNull(GraphQLOrderByFieldType),
    },
    direction: {
      description: 'Ordering direction.',
      type: new GraphQLNonNull(GraphQLOrderDirectionType),
    },
  }),
});
