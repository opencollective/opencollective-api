import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import { assertCanSeeAccount } from '../../../lib/private-accounts';
import TierModel from '../../../models/Tier';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput';
import { GraphQLTier } from '../object/Tier';

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
    const tier = await fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: args.throwIfMissing });
    if (tier) {
      const account = await req.loaders.Collective.byId.load(tier.CollectiveId);
      await assertCanSeeAccount(req, account);
    }
    return tier;
  },
};

export default TierQuery;
