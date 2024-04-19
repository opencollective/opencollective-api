import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLMemberOrderByFieldType, MEMBER_ORDER_BY_PSEUDO_FIELDS } from '../enum/MemberOrderByFieldType';
import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';

export { MEMBER_ORDER_BY_PSEUDO_FIELDS };

export const GraphQLMemberOrderByInput = new GraphQLInputObjectType({
  name: 'MemberOrderByInput',
  description: 'Input to order Member collection',
  fields: () => ({
    field: {
      description: 'Field to order by.',
      type: new GraphQLNonNull(GraphQLMemberOrderByFieldType),
    },
    direction: {
      description: 'Ordering direction.',
      type: new GraphQLNonNull(GraphQLOrderDirectionType),
    },
  }),
});
