import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { types as collectiveTypes } from '../../../constants/collectives';
import models from '../../../models';
import { hasSeenLatestChangelogEntry } from '../../common/user';
import { OAuthAuthorizationCollection } from '../collection/OAuthAuthorizationCollection';
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
        async resolve(userCollective, args, req) {
          if (!req.remoteUser) {
            return null;
          }

          if (req.userToken) {
            if (!req.userToken.getScope().includes('email')) {
              return null;
            }
          }

          const user = await (userCollective.isIncognito
            ? req.loaders.User.byId.load(userCollective.CreatedByUserId) // TODO: Should rely on Member
            : req.loaders.User.byCollectiveId.load(userCollective.id));

          if (user && (await req.loaders.User.canSeeUserPrivateInfo.load(user))) {
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
          const canSeeLocation = req.remoteUser?.isAdmin(individual.id) || (await individual.isHost());
          if (canSeeLocation) {
            // For incognito profiles, we retrieve the location from the main user profile
            if (individual.isIncognito) {
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
          if (!req.remoteUser) {
            return null;
          }

          const user = await req.loaders.User.byCollectiveId.load(collective.id);
          if (!user || user.id !== req.remoteUser.id) {
            return null;
          }

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
            };
          });

          return { nodes, totalCount: result.count, limit, offset };
        },
      },
    };
  },
});

export default Individual;
