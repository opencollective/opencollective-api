import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Tier } from '../object/Tier';

const TierQuery = {
  type: Tier,
  args: {
    tier: {
      type: new GraphQLNonNull(TierReferenceInput),
      description: 'Identifiers to retrieve the tier',
    },
    throwIfMissing: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'If true, an error will be returned if the tier is missing',
      defaultValue: true,
    },
  },
  async resolve(_, args, req): Promise<object | null> {
    return fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: args.throwIfMissing });
  },
};

export default TierQuery;
