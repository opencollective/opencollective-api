import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import Tier from '../../../models/Tier';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

export const GraphQLTierReferenceInput = new GraphQLInputObjectType({
  name: 'TierReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The id assigned to the Tier',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The DB id assigned to the Tier',
    },
    isCustom: {
      type: GraphQLBoolean,
      description: 'Pass this flag to reference the custom tier (/donate)',
    },
  }),
});

/**
 * Retrieves a tier
 *
 * @param {string|number} input - id of the tier
 */
export const fetchTierWithReference = async (
  input,
  { loaders = null, throwIfMissing = false } = {},
): Promise<Tier | null> => {
  const loadTier = id => (loaders ? loaders.Tier.byId.load(id) : Tier.findByPk(id));
  let tier;
  if (input.id) {
    const id = idDecode(input.id, 'tier');
    tier = await loadTier(id);
  } else if (input.legacyId) {
    tier = await loadTier(input.legacyId);
  } else {
    throw new Error('Please provide an id');
  }
  if (!tier && throwIfMissing) {
    throw new NotFound(`Tier Not Found`);
  }
  return tier;
};
