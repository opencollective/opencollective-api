import { GraphQLNonNull, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { OAuthAuthorization } from '../object/OAuthAuthorization';

const oauthAuthorizationMutations = {
  revokeOAuthAuthorization: {
    type: new GraphQLNonNull(OAuthAuthorization),
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        return null;
      }

      const id = parseInt(idDecode(args.id, IDENTIFIER_TYPES.USER_TOKEN));

      const userToken = await models.UserToken.findByPk(id);
      if (!userToken || userToken.user.id !== req.remoteUser.id) {
        throw new NotFound();
      }

      return userToken.destroy();
    },
  },
};

export default oauthAuthorizationMutations;
