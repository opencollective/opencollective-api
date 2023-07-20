import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models/index.js';
import { NotFound } from '../../errors.js';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers.js';

export const PersonalTokenReferenceFields = {
  id: {
    type: GraphQLString,
    description: 'The public id identifying the personal-token (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the personal-token (ie: 4242)',
  },
};

export const GraphQLPersonalTokenReferenceInput = new GraphQLInputObjectType({
  name: 'PersonalTokenReferenceInput',
  fields: () => PersonalTokenReferenceFields,
});

/**
 * Retrieves a personal token
 */
export const fetchPersonalTokenWithReference = async (input, sequelizeOps = undefined) => {
  let personalToken;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.PERSONAL_TOKEN);
    personalToken = await models.PersonalToken.findByPk(id, sequelizeOps);
  } else if (input.legacyId) {
    personalToken = await models.PersonalToken.findByPk(input.legacyId, sequelizeOps);
  } else {
    throw new Error('Please provide an id');
  }

  if (!personalToken) {
    throw new NotFound('Personal token Not Found');
  }
  return personalToken;
};
