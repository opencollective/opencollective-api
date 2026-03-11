import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { FindOptions, InferAttributes } from 'sequelize';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models, { PersonalToken } from '../../../models';
import { NotFound } from '../../errors';
import { Loaders } from '../../loaders';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export const PersonalTokenReferenceFields = {
  id: {
    type: GraphQLString,
    description: `The public id identifying the personal-token (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${EntityShortIdPrefix.PersonalToken}_xxxxxxxx)`,
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The legacy public id identifying the personal-token (ie: 4242)',
    deprecationReason: '2026-02-25: use id',
  },
};

export const GraphQLPersonalTokenReferenceInput = new GraphQLInputObjectType({
  name: 'PersonalTokenReferenceInput',
  fields: () => PersonalTokenReferenceFields,
});

/**
 * Retrieves a personal token
 */
export const fetchPersonalTokenWithReference = async (
  input,
  { loaders = null, ...sequelizeOps }: { loaders?: Loaders } & FindOptions<InferAttributes<PersonalToken>> = {},
) => {
  let personalToken;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.PersonalToken)) {
    personalToken = await (loaders
      ? loaders.PersonalToken.byPublicId.load(input.id)
      : models.PersonalToken.findOne({ ...sequelizeOps, where: { publicId: input.id } }));
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
