import { GraphQLNonNull } from 'graphql';

import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Tier } from '../object/Tier';

const TierQuery = {
  type: Tier,
  args: {
    tier: {
      type: new GraphQLNonNull(TierReferenceInput),
      description: 'Identifiers to retrieve the tier',
    },
  },
  async resolve(_, args, req): Promise<object | null> {
    return fetchTierWithReference(args.tier, req);
  },
};

export default TierQuery;
