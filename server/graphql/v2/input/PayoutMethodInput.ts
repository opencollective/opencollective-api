import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLPayoutMethodType } from '../enum/PayoutMethodType';

/**
 * An input for PayoutMethod that can be used for either editing or creating payout methods.
 */
export const GraphQLPayoutMethodInput = new GraphQLInputObjectType({
  name: 'PayoutMethodInput',
  fields: () => ({
    id: { type: GraphQLString },
    legacyId: { type: GraphQLInt },
    data: { type: GraphQLJSON },
    name: { type: GraphQLString },
    isSaved: { type: GraphQLBoolean },
    type: { type: GraphQLPayoutMethodType },
  }),
});
