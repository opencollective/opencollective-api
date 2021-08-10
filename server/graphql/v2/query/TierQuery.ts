import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import models from '../../../models';
import { Query } from '../../../types/graphql';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';
import { Tier } from '../object/Tier';

const TierQueryArgs = {
  tier: {
    type: new GraphQLNonNull(TierReferenceInput),
    description: 'Identifiers to retrieve the tier',
  },
  throwIfMissing: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'If true, an error will be returned if the tier is missing',
    defaultValue: true,
  },
};

const TierQuery: Query<typeof TierQueryArgs> = {
  type: Tier,
  args: TierQueryArgs,
  async resolve(_: void, args, req): Promise<typeof models.Tier | null> {
    return fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: args.throwIfMissing });
  },
};

export default TierQuery;
