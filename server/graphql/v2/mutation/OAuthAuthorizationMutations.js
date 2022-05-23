import { GraphQLNonNull } from 'graphql';

import { NotFound } from '../../errors';
import {
  fetchOauthAuthorizationWithReference,
  OauthAuthorizationReferenceInput,
} from '../input/OauthAuthorizationReferenceInput';
import { OauthAuthorization } from '../object/OauthAuthorization';

const oauthAuthorizationMutations = {
  revokeOauthAuthorization: {
    type: new GraphQLNonNull(OauthAuthorization),
    args: {
      oauthAuthorization: {
        type: new GraphQLNonNull(OauthAuthorizationReferenceInput),
        description: 'Reference of the OAuth Authorization',
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        return null;
      }

      const userToken = await fetchOauthAuthorizationWithReference(args.oauthAuthorization);
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
