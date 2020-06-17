import { GraphQLInputObjectType, GraphQLString } from 'graphql';

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
  }),
});

/**
 * Retrieves a tier
 *
 * @param {string|number} input - id of the tier
 */
export const fetchTierWithReference = async input => {
  let tier;
  if (input.id) {
    const id = idDecode(input.id, 'tier');
    tier = await models.Tier.findByPk(id);
  } else {
    throw new Error('Please provide an id');
  }
  if (!tier) {
    throw new NotFound('Payment Method Not Found');
  }
  return tier;
};
