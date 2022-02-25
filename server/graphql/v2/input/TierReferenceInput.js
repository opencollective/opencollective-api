import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';

export const TierReferenceInput = new GraphQLInputObjectType({
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
    slug: {
      type: GraphQLString,
      description: `The slug identifying the Tier.`,
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
  { loaders = null, throwIfMissing, allowCustomTier = false, account } = {},
) => {
  const loadTier = id => (loaders ? loaders.Tier.byId.load(id) : models.Tier.findByPk(id));
  let tier;
  if (input.id) {
    const id = idDecode(input.id, 'tier');
    tier = await loadTier(id);
  } else if (input.legacyId) {
    tier = await loadTier(input.legacyId);
  } else if (input.slug) {
    if (!account) {
      throw new NotFound('Tier can only be fetched with slug reference when an account is specified');
    }
    tier = await models.Tier.findOne({ CollectiveId: account.id, slug: input.slug });
  } else if (allowCustomTier && input.isCustom) {
    return 'custom';
  } else {
    throw new Error('Please provide an id');
  }
  if (!tier && throwIfMissing) {
    throw new NotFound(`Tier Not Found`);
  }
  return tier;
};
