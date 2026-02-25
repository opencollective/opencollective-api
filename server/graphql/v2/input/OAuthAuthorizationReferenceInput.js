import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

const OAuthAuthorizationReferenceFields = {
  publicId: {
    type: GraphQLString,
    description: `The resource public id (ie: ${models.UserToken.nanoIdPrefix}_xxxxxxxx)`,
  },
  id: {
    type: GraphQLString,
    description: 'The id identifying the OAuth Authorization (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    deprecationReason: '2026-02-25: use publicId',
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
  if (input.publicId) {
    const expectedPrefix = models.UserToken.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for OAuth Authorization, expected prefix ${expectedPrefix}_`);
    }

    userToken = await models.UserToken.findOne({ where: { publicId: input.publicId } });
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
