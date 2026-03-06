import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

const OAuthAuthorizationReferenceFields = {
  id: {
    type: GraphQLString,
    description: `The id identifying the OAuth Authorization (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${EntityShortIdPrefix.UserToken}_xxxxxxxx)`,
  },
};

export const GraphQLOAuthAuthorizationReferenceInput = new GraphQLInputObjectType({
  name: 'OAuthAuthorizationReferenceInput',
  fields: () => OAuthAuthorizationReferenceFields,
});

/**
 * Retrieves an OAuth Authorization
 *
 * @param {object} input - id of the OAuth Authorization
 */
export const fetchOAuthAuthorizationWithReference = async input => {
  let userToken;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.UserToken)) {
    userToken = await models.UserToken.findOne({ where: { publicId: input.id } });
  } else if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.USER_TOKEN);
    userToken = await models.UserToken.findByPk(id);
  } else {
    throw new Error('Please provide an id');
  }
  if (!userToken) {
    throw new NotFound('OAuth Authorization Not Found');
  }
  return userToken;
};
