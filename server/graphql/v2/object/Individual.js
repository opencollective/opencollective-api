import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { types as collectiveTypes } from '../../../constants/collectives';
import models from '../../../models';
import { checkScope } from '../../common/scope-check';
import { hasSeenLatestChangelogEntry } from '../../common/user';
import { OAuthAuthorizationCollection } from '../collection/OAuthAuthorizationCollection';
import { PersonalTokenCollection } from '../collection/PersonalTokenCollection';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { Account, AccountFields } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { Host } from './Host';

export const Individual = new GraphQLObjectType({
  name: 'Individual',
  description: 'This represents an Individual account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === collectiveTypes.USER,
  fields: () => {
    return {
      ...AccountFields,
      email: {
        type: GraphQLString,
        description: 'Email for the account. For authenticated user: scope: "email".',
        async resolve(userCollective, args, req) {
          if (!req.remoteUser) {
            return null;
          }
          if (req.remoteUser.CollectiveId === userCollective.id && !checkScope(req, 'email')) {
            return null;
          }

          const user = await (userCollective.isIncognito
            ? req.loaders.User.byId.load(userCollective.CreatedByUserId) // TODO: Should rely on Member
            : req.loaders.User.byCollectiveId.load(userCollective.id));

          if (user && (await req.loaders.Collective.canSeePrivateInfo.load(user.CollectiveId))) {
            return user.email;
          }
        },
      },
      isGuest: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve(account) {
          return Boolean(account.data?.isGuest);
        },
      },
      isFollowingConversation: {
        type: new GraphQLNonNull(GraphQLBoolean),
        args: {
          id: {
            type: new GraphQLNonNull(GraphQLString),
          },
        },
        async resolve(collective, args, req) {
          const conversationId = parseInt(idDecode(args.id, IDENTIFIER_TYPES.CONVERSATION));
          const user = await req.loaders.User.byCollectiveId.load(collective.id);

          if (!user) {
            return false;
          } else {
            return models.ConversationFollower.isFollowing(user.id, conversationId);
          }
        },
      },
      location: {
        ...AccountFields.location,
        description: `
          Address. This field is public for hosts, otherwise:
            - Users can see their own address
            - Hosts can see the address of users submitting expenses to their collectives
        `,
        async resolve(individual, _, req) {
          const isHost = await individual.isHost();
          const canSeeLocation = isHost || (req.remoteUser?.isAdmin(individual.id) && checkScope(req, 'account'));
          if (canSeeLocation) {
            // For incognito profiles, we retrieve the location from the main user profile
            if (individual.isIncognito) {
              if (!checkScope(req, 'incognito')) {
                return null;
              }
              const mainProfile = await req.loaders.Collective.mainProfileFromIncognito.load(individual.id);
              if (mainProfile) {
                return mainProfile.location;
              }
            }

            return individual.location;
          }
        },
      },
      hasTwoFactorAuth: {
        type: GraphQLBoolean,
        async resolve(collective, args, req) {
          const user = await req.loaders.User.byCollectiveId.load(collective.id);
          if (user.twoFactorAuthToken) {
            return true;
          } else {
            return false;
          }
        },
      },
      newsletterOptIn: {
        type: GraphQLBoolean,
        async resolve(collective, _, req) {
          if (!req.remoteUser?.isAdmin(collective.id) || !checkScope(req, 'account')) {
            return null;
          }
          const user = await req.loaders.User.byCollectiveId.load(collective.id);
          if (user.newsletterOptIn) {
            return true;
          } else {
            return false;
          }
        },
      },
      host: {
        type: Host,
        description: 'If the individual is a host account, this will return the matching Host object',
        resolve(collective) {
          if (collective.isHostAccount) {
            return collective;
          }
        },
      },
      hasSeenLatestChangelogEntry: {
        type: new GraphQLNonNull(GraphQLBoolean),
        async resolve(collective, args, req) {
          const user = await req.loaders.User.byCollectiveId.load(collective.id);
          return hasSeenLatestChangelogEntry(user);
        },
      },
      oAuthAuthorizations: {
        type: OAuthAuthorizationCollection,
        args: {
          ...CollectionArgs,
        },
        async resolve(collective, { limit, offset }, req) {
          if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'account')) {
            return null;
          }

          const user = await req.loaders.User.byCollectiveId.load(collective.id);

          const query = { where: { UserId: user.id } };

          if (limit) {
            query.limit = limit;
          }
          if (offset) {
            query.offset = offset;
          }

          const result = await models.UserToken.findAndCountAll(query);
          const nodes = result.rows.map(row => {
            return {
              id: row.id,
              account: collective,
              application: row.client,
              expiresAt: row.accessTokenExpiresAt,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              scope: row.scope,
              user,
            };
          });

          return { nodes, totalCount: result.count, limit, offset };
        },
      },
      personalTokens: {
        type: PersonalTokenCollection,
        description: 'The list of personal tokens created by this account. Admin only. Scope: "applications".',
        args: {
          ...CollectionArgs,
        },
        async resolve(collective, args, req) {
          if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'applications')) {
            return null;
          }
          const { limit, offset } = args;
          const order = [['createdAt', 'DESC']];

          const result = await models.PersonalToken.findAndCountAll({
            where: { CollectiveId: collective.id },
            order,
            limit,
            offset,
          });

          return { nodes: result.rows, totalCount: result.count, limit, offset };
        },
      },
    };
  },
});

export default Individual;
