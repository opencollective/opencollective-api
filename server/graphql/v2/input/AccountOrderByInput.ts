import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { ACCOUNT_ORDER_BY_PSEUDO_FIELDS, GraphQLAccountOrderByFieldType } from '../enum/AccountOrderByFieldType';
import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';

export { ACCOUNT_ORDER_BY_PSEUDO_FIELDS };

export const GraphQLAccountOrderByInput = new GraphQLInputObjectType({
  name: 'AccountOrderByInput',
  description: 'Input to order Account collection',
  fields: () => ({
    field: {
      description: 'Field to order by.',
      type: new GraphQLNonNull(GraphQLAccountOrderByFieldType),
    },
    direction: {
      description: 'Ordering direction.',
      type: new GraphQLNonNull(GraphQLOrderDirectionType),
    },
  }),
});
