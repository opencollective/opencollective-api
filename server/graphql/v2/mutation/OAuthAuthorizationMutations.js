import { GraphQLNonNull } from 'graphql';

import { NotFound } from '../../errors';
import {
  fetchOAuthAuthorizationWithReference,
  OAuthAuthorizationReferenceInput,
} from '../input/OAuthAuthorizationReferenceInput';
import { OAuthAuthorization } from '../object/OAuthAuthorization';

const oauthAuthorizationMutations = {
  revokeOAuthAuthorization: {
    type: new GraphQLNonNull(OAuthAuthorization),
    args: {
      oauthAuthorization: {
        type: new GraphQLNonNull(OAuthAuthorizationReferenceInput),
        description: 'Reference of the OAuth Authorization',
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        return null;
      }

      const userToken = await fetchOAuthAuthorizationWithReference(args.oauthAuthorization);
      if (!userToken || userToken.user.id !== req.remoteUser.id) {
        throw new NotFound();
      }

      await userToken.destroy();

      const account = await userToken.user.getCollective();
      return {
        id: userToken.id,
        account: account,
        application: userToken.client,
        expiresAt: userToken.accessTokenExpiresAt,
        createdAt: userToken.createdAt,
        updatedAt: userToken.updatedAt,
      };
    },
  },
};

export default oauthAuthorizationMutations;
