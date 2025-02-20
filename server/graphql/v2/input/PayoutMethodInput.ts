import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLPayoutMethodType } from '../enum/PayoutMethodType';

/**
 * An input for PayoutMethod that can be used for either editing or creating payout methods.
 */
export const GraphQLPayoutMethodInput = new GraphQLInputObjectType({
  name: 'PayoutMethodInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The unique identifier of the payout method',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The legacy identifier used in older systems',
    },
    data: {
      type: GraphQLJSON,
      description:
        'Additional data specific to the payout method type. For custom payout methods (type=OTHER), must contain only `content` (string) and `currency` fields. For other types, may contain type-specific details (e.g., bank account details, PayPal email)',
    },
    name: {
      type: GraphQLString,
      description: 'A human-readable name for the payout method',
    },
    isSaved: {
      type: GraphQLBoolean,
      description: 'Whether this payout method should be saved for future use',
    },
    type: {
      type: GraphQLPayoutMethodType,
      description: 'The type of payout method (e.g., PayPal, bank transfer)',
    },
  }),
});
