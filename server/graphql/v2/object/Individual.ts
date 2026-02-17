import type { Request } from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { uniqBy } from 'lodash';
import { WhereOptions } from 'sequelize';

import { roles } from '../../../constants';
import { CollectiveType } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import { KYCProviderName } from '../../../lib/kyc/providers';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Collective, Op } from '../../../models';
import { KYCVerification } from '../../../models/KYCVerification';
import UserTwoFactorMethod from '../../../models/UserTwoFactorMethod';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkRemoteUserCanUseKYC, checkScope } from '../../common/scope-check';
import { hasSeenLatestChangelogEntry } from '../../common/user';
import { Forbidden } from '../../errors';
import { GraphQLKYCVerificationCollection } from '../collection/KYCVerificationCollection';
import { GraphQLOAuthAuthorizationCollection } from '../collection/OAuthAuthorizationCollection';
import { GraphQLPersonalTokenCollection } from '../collection/PersonalTokenCollection';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import {
  fetchAccountsIdsWithReference,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { GraphQLContributorProfile } from './ContributorProfile';
import { GraphQLHost } from './Host';
import { GraphQLKYCStatus } from './KYCStatus';
import { UserTwoFactorMethod as UserTwoFactorMethodObject } from './UserTwoFactorMethod';

export const GraphQLIndividual = new GraphQLObjectType({
  name: 'Individual',
  description: 'This represents an Individual account',
  interfaces: () => [GraphQLAccount],
  isTypeOf: collective => collective.type === CollectiveType.USER,
  fields: () => {
    return {
      ...AccountFields,
      company: {
        type: GraphQLString,
        description: 'Company slugs the user is part of.',
      },
      email: {
        type: GraphQLString,
        description: 'Email for the account. For authenticated user: scope: "email".',
        async resolve(userCollective, args, req: Request) {
          if (!req.remoteUser || userCollective.isIncognito) {
            return null;
          } else if (req.remoteUser.CollectiveId === userCollective.id && !checkScope(req, 'email')) {
            return null;
          } else {
            if (await req.loaders.Collective.canSeePrivateProfileInfo.load(userCollective.id)) {
              const user = await req.loaders.User.byCollectiveId.load(userCollective.id);
              return user?.email;
            }
          }
        },
      },
      isGuest: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve(account) {
          return Boolean(account.data?.isGuest);
        },
      },
      emailWaitingForValidation: {
        type: GraphQLEmailAddress,
        description: 'Email address waiting for validation. Only visible to the user themselves.',
        async resolve(account: Collective, _, req: Request) {
          if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(account)) {
            return null;
          }
          if (!checkScope(req, 'account')) {
            return null;
          }
          const user = await req.loaders.User.byCollectiveId.load(account.id);
          return user?.emailWaitingForValidation;
        },
      },
      isLimited: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: "Returns true if user account is limited (user can't use any feature)",
        async resolve(account: Collective, _, req: Request) {
          const user = await req.loaders.User.byCollectiveId.load(account.id);
          return Boolean(user?.data?.features?.[FEATURE.ALL] === false);
        },
      },
      isRoot: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns true if user is a root user. Only visible to the user themselves.',
        async resolve(account: Collective, _, req: Request) {
          if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(account)) {
            return false;
          }
          const user = await req.loaders.User.byCollectiveId.load(account.id);
          return user?.isRoot() ?? false;
        },
      },
      requiresProfileCompletion: {
        type: GraphQLBoolean,
        async resolve(account: Collective, _, req) {
          const user = await req.loaders.User.byCollectiveId.load(account.id);
          if (req.remoteUser?.id === user.id) {
            return Boolean(account.data?.requiresProfileCompletion);
          }
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
          const conversationId = idDecode(args.id, IDENTIFIER_TYPES.CONVERSATION);
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
          const canSeeLocation =
            (await individual.isHost()) ||
            (checkScope(req, 'account') &&
              (req.remoteUser?.isAdmin(individual.id) ||
                getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_LOCATION, individual.id)));

          if (!canSeeLocation) {
            return null;
          }

          let location;
          // For incognito profiles, we retrieve the location from the main user profile
          if (individual.isIncognito) {
            if (!checkScope(req, 'incognito')) {
              return null;
            }
            const mainProfile = await req.loaders.Collective.mainProfileFromIncognito.load(individual.id);
            if (mainProfile) {
              location = await req.loaders.Location.byCollectiveId.load(mainProfile.id);
            }
          }

          location = location || (await req.loaders.Location.byCollectiveId.load(individual.id));
          if (!location && individual.countryISO) {
            location = { country: individual.countryISO };
            if (individual.address) {
              location.address = individual.address;
            }
          }
          return location;
        },
      },
      hasTwoFactorAuth: {
        type: GraphQLBoolean,
        async resolve(collective, args, req) {
          const user = await req.loaders.User.byCollectiveId.load(collective.id);
          if (req.remoteUser?.id === user.id) {
            return twoFactorAuthLib.userHasTwoFactorAuthEnabled(user);
          }
        },
      },
      newsletterOptIn: {
        type: GraphQLBoolean,
        async resolve(userCollective, _, req) {
          if (!req.remoteUser || userCollective.isIncognito) {
            return null;
          } else if (req.remoteUser.CollectiveId === userCollective.id && !checkScope(req, 'account')) {
            return null;
          } else {
            if (await req.loaders.Collective.canSeePrivateProfileInfo.load(userCollective.id)) {
              const user = await req.loaders.User.byCollectiveId.load(userCollective.id);
              return user?.newsletterOptIn;
            }
          }
        },
      },
      host: {
        type: GraphQLHost,
        description: 'If the individual is a host account, this will return the matching Host object',
        resolve(collective) {
          if (collective.hasMoneyManagement) {
            return collective;
          }
        },
      },
      hasSeenLatestChangelogEntry: {
        type: GraphQLBoolean,
        async resolve(collective, args, req) {
          const user = await req.loaders.User.byCollectiveId.load(collective.id);
          if (req.remoteUser?.id !== user.id) {
            return null;
          }
          return hasSeenLatestChangelogEntry(user);
        },
      },
      oAuthAuthorizations: {
        type: GraphQLOAuthAuthorizationCollection,
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
            query['limit'] = limit;
          }
          if (offset) {
            query['offset'] = offset;
          }

          const result = await models.UserToken.findAndCountAll(query);
          const nodes = result.rows.map(row => {
            return {
              id: row.id,
              account: collective,
              application: row.application,
              expiresAt: row.accessTokenExpiresAt,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              preAuthorize2FA: row.preAuthorize2FA,
              scope: row.scope,
              user,
            };
          });

          return { nodes, totalCount: result.count, limit, offset };
        },
      },
      personalTokens: {
        type: GraphQLPersonalTokenCollection,
        description: 'The list of personal tokens created by this account. Admin only. Scope: "applications".',
        args: {
          ...CollectionArgs,
        },
        async resolve(collective, args, req) {
          if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'applications')) {
            return null;
          }
          const { limit, offset } = args;

          const result = await models.PersonalToken.findAndCountAll({
            where: { CollectiveId: collective.id },
            order: [['createdAt', 'DESC']],
            limit,
            offset,
          });

          return { nodes: result.rows, totalCount: result.count, limit, offset };
        },
      },
      hasPassword: {
        type: GraphQLBoolean,
        description: 'Has the account a password set? For authenticated user: scope: "account".',
        async resolve(collective, args, req) {
          if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'account')) {
            return null;
          }

          return req.remoteUser.passwordHash ? true : false;
        },
      },
      twoFactorMethods: {
        type: new GraphQLList(UserTwoFactorMethodObject),
        description: 'User two factor methods',
        async resolve(collective, _, req) {
          if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'account')) {
            return null;
          }

          return UserTwoFactorMethod.findAll({
            where: {
              UserId: req.remoteUser.id,
            },
          });
        },
      },
      contributorProfiles: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLContributorProfile)),
        args: {
          forAccount: {
            type: new GraphQLNonNull(GraphQLAccountReferenceInput),
          },
        },
        async resolve(userCollective: Collective, args, req: Request) {
          const loggedInUser = req.remoteUser;
          const forAccount = await fetchAccountWithReference(args.forAccount, {
            throwIfMissing: true,
            loaders: req.loaders,
          });

          if (!loggedInUser || !req.remoteUser?.isAdminOfCollective(userCollective)) {
            return [];
          }

          const memberships = await models.Member.findAll({
            where: {
              MemberCollectiveId: loggedInUser.CollectiveId,
              role: roles.ADMIN,
              CollectiveId: { [Op.ne]: forAccount.id },
            },
            include: [
              {
                model: models.Collective,
                as: 'collective',
                required: true,
                where: {
                  [Op.or]: [
                    {
                      type: { [Op.in]: [CollectiveType.COLLECTIVE, CollectiveType.FUND] },
                      HostCollectiveId: forAccount.HostCollectiveId,
                    },
                    {
                      type: { [Op.in]: [CollectiveType.ORGANIZATION, CollectiveType.USER] },
                    },
                  ],
                },
                include: [
                  {
                    model: models.Collective,
                    as: 'children',
                    where: { HostCollectiveId: forAccount.HostCollectiveId },
                    required: false,
                  },
                ],
              },
            ],
          });

          const contributorProfiles = [{ account: userCollective, forAccount }];
          memberships.forEach(membership => {
            contributorProfiles.push({ account: membership.collective, forAccount });
            membership.collective.children?.forEach(children => {
              contributorProfiles.push({ account: children, forAccount });
            });
          });
          return uniqBy(contributorProfiles, 'account.id');
        },
      },
      kycVerifications: {
        type: new GraphQLNonNull(GraphQLKYCVerificationCollection),
        description: 'KYC Verification requests to this account',
        args: {
          ...CollectionArgs,
          requestedByAccounts: {
            description: 'If set, returns only KYC requests made by these accounts',
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
          },
        },
        async resolve(account, args, req: Express.Request) {
          checkRemoteUserCanUseKYC(req);

          const requestedByAccountIds =
            (await fetchAccountsIdsWithReference(args.requestedByAccounts, { throwIfMissing: true })) || [];

          const hasAccess =
            requestedByAccountIds.length > 0 && requestedByAccountIds.every(id => req.remoteUser.isAdmin(id));

          if (!hasAccess) {
            throw new Forbidden();
          }

          const where: WhereOptions<KYCVerification> = {
            ...(requestedByAccountIds.length > 0 ? { RequestedByCollectiveId: requestedByAccountIds } : {}),
            CollectiveId: account.id,
          };

          return {
            limit: args.limit,
            offset: args.offset,
            async totalCount() {
              return await KYCVerification.count({
                where,
              });
            },
            async nodes() {
              return await KYCVerification.findAll({
                where,
                limit: args.limit,
                offset: args.offset,
                order: [['id', 'DESC']],
              });
            },
          };
        },
      },
      kycStatus: {
        type: new GraphQLNonNull(GraphQLKYCStatus),
        description: 'Verified KYC status, if any',
        args: {
          requestedByAccount: {
            description: 'If set, returns only KYC requests made by these accounts',
            type: new GraphQLNonNull(GraphQLAccountReferenceInput),
          },
        },
        async resolve(account, args, req: Express.Request) {
          checkRemoteUserCanUseKYC(req);
          const requestedByAccount = await fetchAccountWithReference(args.requestedByAccount, {
            throwIfMissing: true,
            loaders: req.loaders,
          });

          const isRequesterAdmin = req.remoteUser.isAdminOfCollective(requestedByAccount);
          const hasAccess = isRequesterAdmin;

          if (!hasAccess) {
            throw new Forbidden();
          }

          return Object.fromEntries(
            Object.values(KYCProviderName).map(provider => [
              provider,
              () =>
                req.loaders.KYCVerification.verifiedStatusByProvider(requestedByAccount.id, provider).load(account.id),
            ]),
          );
        },
      },
    };
  },
});
