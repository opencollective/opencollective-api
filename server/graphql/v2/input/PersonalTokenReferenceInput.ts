import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const PersonalTokenReferenceFields = {
  publicId: {
    type: GraphQLString,
    description: `The resource public id (ie: ${models.PersonalToken.nanoIdPrefix}_xxxxxxxx)`,
  },
  id: {
    type: GraphQLString,
    description: 'The public id identifying the personal-token (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    deprecationReason: '2026-02-25: use publicId',
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the personal-token (ie: 4242)',
    deprecationReason: '2026-02-25: use publicId',
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
  if (input.publicId) {
    const expectedPrefix = models.PersonalToken.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for PersonalToken, expected prefix ${expectedPrefix}_`);
    }

    personalToken = await models.PersonalToken.findOne({ ...sequelizeOps, where: { publicId: input.publicId } });
  } else if (input.id) {
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
