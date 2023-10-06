import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import models from '../../../models';
import { checkScope } from '../../common/scope-check';
import { GraphQLApplicationType } from '../enum';
import { idEncode } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLOAuthAuthorization } from '../object/OAuthAuthorization';
import URL from '../scalar/URL';

export const GraphQLApplication = new GraphQLObjectType({
  name: 'Application',
  description: 'An OAuth application.',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(order) {
        return idEncode(order.id, 'order');
      },
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      resolve(order) {
        return order.id;
      },
    },
    type: {
      type: GraphQLApplicationType,
      deprecationReason:
        '2022-06-16: This Application object will only be used for OAuth tokens. Use PersonalToken for user tokens',
      resolve(application) {
        return application.type;
      },
    },
    name: {
      type: GraphQLString,
      resolve(application) {
        return application.name;
      },
    },
    description: {
      type: GraphQLString,
      resolve(application) {
        return application.description;
      },
    },
    apiKey: {
      type: GraphQLString,
      deprecationReason:
        '2022-06-16: This Application object will only be used for OAuth tokens. Use PersonalToken for user tokens',
      resolve(application, args, req) {
        if (req.remoteUser?.isAdmin(application.CollectiveId)) {
          return application.apiKey;
        }
      },
    },
    clientId: {
      type: GraphQLString,
      resolve(application) {
        return application.clientId;
      },
    },
    clientSecret: {
      type: GraphQLString,
      resolve(application, args, req) {
        if (req.remoteUser?.isAdmin(application.CollectiveId)) {
          return application.clientSecret;
        }
      },
    },
    redirectUri: {
      type: URL,
      resolve(application) {
        return application.callbackUrl;
      },
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(application, args, req) {
        return req.loaders.Collective.byId.load(application.CollectiveId);
      },
    },
    oAuthAuthorization: {
      type: GraphQLOAuthAuthorization,
      async resolve(application, args, req) {
        if (!req.remoteUser || !checkScope(req, 'account')) {
          return null;
        }
        const userToken = await models.UserToken.findOne({
          where: { ApplicationId: application.id, UserId: req.remoteUser.id },
        });
        if (userToken) {
          return {
            id: userToken.id,
            account: req.remoteUser.collective,
            application: userToken.client,
            expiresAt: userToken.accessTokenExpiresAt,
            createdAt: userToken.createdAt,
            updatedAt: userToken.updatedAt,
            scope: userToken.scope,
            user: req.remoteUser,
          };
        }
      },
    },
  }),
});
