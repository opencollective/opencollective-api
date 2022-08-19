import { GraphQLNonNull } from 'graphql';

import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { NotFound } from '../../errors';
import {
  fetchOAuthAuthorizationWithReference,
  OAuthAuthorizationReferenceInput,
} from '../input/OAuthAuthorizationReferenceInput';
import { OAuthAuthorization } from '../object/OAuthAuthorization';

const oAuthAuthorizationMutations = {
  revokeOAuthAuthorization: {
    type: new GraphQLNonNull(OAuthAuthorization),
    description: 'Revoke an OAuth authorization. Scope: "account".',
    args: {
      oAuthAuthorization: {
        type: new GraphQLNonNull(OAuthAuthorizationReferenceInput),
        description: 'Reference of the OAuth Authorization',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const userToken = await fetchOAuthAuthorizationWithReference(args.oAuthAuthorization);
      if (!userToken || userToken.user.id !== req.remoteUser.id) {
        throw new NotFound();
      }

      await userToken.destroy();

      return {
        id: userToken.id,
        account: req.remoteUser.collective,
        application: userToken.client,
        expiresAt: userToken.accessTokenExpiresAt,
        createdAt: userToken.createdAt,
        updatedAt: userToken.updatedAt,
        user: req.remoteUser,
      };
    },
  },
};

export default oAuthAuthorizationMutations;
