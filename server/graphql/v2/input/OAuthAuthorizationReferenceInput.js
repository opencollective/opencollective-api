import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models from '../../../models/index.js';
import { NotFound } from '../../errors.js';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers.js';

export const OAuthAuthorizationReferenceFields = {
  id: {
    type: GraphQLString,
    description: 'The id identifying the OAuth Authorization (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
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
  if (input.id) {
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
