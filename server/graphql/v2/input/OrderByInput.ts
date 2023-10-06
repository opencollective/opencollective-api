import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLOrderByFieldType, ORDER_BY_PSEUDO_FIELDS } from '../enum/OrderByFieldType';
import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';

export { ORDER_BY_PSEUDO_FIELDS };

// TODO: This should be called "AccountOrderInput", as the fields are only available for accounts
export const GraphQLOrderByInput = new GraphQLInputObjectType({
  name: 'OrderByInput',
  description: 'Input to order results',
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
