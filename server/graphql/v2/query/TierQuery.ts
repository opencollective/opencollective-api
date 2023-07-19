import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import TierModel from '../../../models/Tier.js';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput.js';
import { GraphQLTier } from '../object/Tier.js';

const TierQuery = {
  type: GraphQLTier,
  args: {
    tier: {
      type: new GraphQLNonNull(GraphQLTierReferenceInput),
      description: 'Identifiers to retrieve the tier',
    },
    throwIfMissing: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'If true, an error will be returned if the tier is missing',
      defaultValue: true,
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<TierModel | null> {
    return <Promise<TierModel>>(
      fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: args.throwIfMissing })
    );
  },
};

export default TierQuery;
