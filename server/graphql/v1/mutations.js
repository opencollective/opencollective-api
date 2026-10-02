import config from 'config';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { checkCaptcha, isCaptchaSetup } from '../../lib/check-captcha';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../lib/rate-limit';
import { reportMessageToSentry } from '../../lib/sentry';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import { editPublicMessage } from '../common/members';
import {
  checkRemoteUserCanUseAccount,
  checkRemoteUserCanUseHost,
  checkRemoteUserCanUseOrders,
  checkRemoteUserCanUseWebhooks,
} from '../common/scope-check';
import { createUser } from '../common/user';
import { NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../errors';

import {
  activateCollectiveAsHost,
  archiveCollective,
  createCollective,
  createCollectiveFromGithub,
  deactivateCollectiveAsHost,
  deleteCollective,
  editCollective,
  unarchiveCollective,
} from './mutations/collectives';
import { editWebhooks } from './mutations/notifications';
import * as paymentMethodsMutation from './mutations/paymentMethods';
import { updateUserEmail } from './mutations/users';
import { CollectiveInterfaceType } from './CollectiveInterface';
import {
  CaptchaInputType,
  CollectiveInputType,
  MemberInputType,
  NotificationInputType,
  StripeCreditCardDataInputType,
  UserInputType,
} from './inputTypes';
import { MemberType, NotificationType, PaymentMethodType, UserType } from './types';

const mutations = {
  createCollective: {
    type: CollectiveInterfaceType,
    args: {
      collective: { type: new GraphQLNonNull(CollectiveInputType) },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req, {
        signedOutMessage: 'You need to be logged in to create a collective',
      });
      return createCollective(_, args, req);
    },
  },
  createCollectiveFromGithub: {
    type: CollectiveInterfaceType,
    deprecationReason: '2022-05-03: This mutation is deprecated and can only be used in test environments.',
    args: {
      collective: { type: new GraphQLNonNull(CollectiveInputType) },
    },
    // eslint-disable-next-line graphql-mutations/require-scope-check -- deprecated mutation only available in test environments
    resolve(_, args, req) {
      return createCollectiveFromGithub(_, args, req);
    },
  },
  editCollective: {
    type: CollectiveInterfaceType,
    args: {
      collective: { type: new GraphQLNonNull(CollectiveInputType) },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req, {
        signedOutMessage: 'You need to be logged in to edit a collective',
      });
      return editCollective(_, args, req);
    },
  },
  deleteCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);
      return deleteCollective(_, args, req);
    },
  },
  deleteUserCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);
      return deleteCollective(_, args, req);
    },
  },
  archiveCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req, {
        signedOutMessage: 'You need to be logged in to archive a collective',
      });
      return archiveCollective(_, args, req);
    },
  },
  unarchiveCollective: {
    type: CollectiveInterfaceType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);
      return unarchiveCollective(_, args, req);
    },
  },
  createUser: {
    description: 'Create a user with an optional organization.',
    type: new GraphQLObjectType({
      name: 'CreateUserResult',
      fields: {
        user: { type: UserType },
        organization: { type: CollectiveInterfaceType },
      },
    }),
    args: {
      user: {
        type: new GraphQLNonNull(UserInputType),
        description: 'The user info',
      },
      organization: {
        type: CollectiveInputType,
        description: 'An optional organization to create alongside the user',
      },
      redirect: {
        type: GraphQLString,
        description: 'The redirect URL for the login email sent to the user',
        defaultValue: '/',
      },
      websiteUrl: {
        type: GraphQLString,
        description: 'The website URL originating the request',
      },
      throwIfExists: {
        type: GraphQLBoolean,
        description: 'If set to false, will act like just like a Sign In and returns the user',
        defaultValue: true,
      },
      sendSignInLink: {
        type: GraphQLBoolean,
        description: 'If true, a signIn link will be sent to the user',
        defaultValue: true,
      },
      captcha: {
        type: CaptchaInputType,
        description: 'Captcha verification data',
      },
    },
    // eslint-disable-next-line graphql-mutations/require-scope-check -- public mutation for account creation, no token scope required
    async resolve(_, args, req) {
      const { remoteUser } = req;
      const rateLimitKey = remoteUser ? `user_create_${remoteUser.id}` : `user_create_ip_${req.ip}`;
      const rateLimit = new RateLimit(rateLimitKey, config.limits.userSignUpPerHour, ONE_HOUR_IN_SECONDS, true);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      if (args.captcha) {
        await checkCaptcha(args.captcha, req.ip);
      } else if (!remoteUser && isCaptchaSetup()) {
        throw new ValidationFailed('Captcha is required');
      } else {
        reportMessageToSentry('CreateUser request without captcha', {
          severity: 'warning',
          extra: { args },
        });
      }

      return createUser(args.user, {
        organizationData: args.organization,
        sendSignInLink: args.sendSignInLink,
        throwIfExists: args.throwIfExists,
        redirect: args.redirect,
        websiteUrl: args.websiteUrl,
        creationRequest: {
          ip: req.ip,
          userAgent: req.header('user-agent'),
        },
      });
    },
  },
  updateUserEmail: {
    type: UserType,
    description: 'Update the email address for logged in user',
    args: {
      email: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The new email address for user',
      },
    },
    resolve: async (_, { email }, req) => {
      checkRemoteUserCanUseAccount(req);
      await twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true });
      return updateUserEmail(req.remoteUser, email);
    },
  },
  editCoreContributors: {
    type: CollectiveInterfaceType,
    description: 'Updates all the core contributors (role = ADMIN or MEMBER) for this collective.',
    deprecationReason: '2021-07-02: Please use inviteMember, editMember or removeMember mutations from GraphQLV2',
    args: {
      collectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      members: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(MemberInputType))) },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);
      const collective = await req.loaders.Collective.byId.load(args.collectiveId);
      if (!collective) {
        throw new NotFound();
      } else if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized();
      } else {
        await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

        await collective.editMembers(args.members, {
          CreatedByUserId: req.remoteUser.id,
          remoteUserCollectiveId: req.remoteUser.CollectiveId,
        });
        return collective;
      }
    },
  },
  editPublicMessage: {
    type: new GraphQLList(MemberType),
    description: 'A mutation to edit the public message of all matching members.',
    deprecationReason: '2021-01-27: Please use editPublicMessage from GraphQLV2',
    args: {
      FromCollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      message: { type: GraphQLString },
    },
    resolve: editPublicMessage,
  },
  replaceCreditCard: {
    type: PaymentMethodType,
    description: 'Replace a payment method',
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      name: { type: new GraphQLNonNull(GraphQLString) },
      token: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(StripeCreditCardDataInputType) },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseOrders(req);
      return paymentMethodsMutation.replaceCreditCard(args, req);
    },
  },
  editWebhooks: {
    type: new GraphQLList(NotificationType),
    description: 'Edits (by replacing) the admin-level webhooks for a collective.',
    args: {
      collectiveId: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the collective whose webhooks are edited.',
      },
      notifications: {
        type: new GraphQLList(NotificationInputType),
        description: 'New notifications for the collective.',
      },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseWebhooks(req);
      return editWebhooks(args, req);
    },
  },
  activateCollectiveAsHost: {
    type: CollectiveInterfaceType,
    description: 'Activate a collective as Host.',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the collective (Organization or User)',
      },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseHost(req);
      return activateCollectiveAsHost(_, args, req);
    },
  },
  deactivateCollectiveAsHost: {
    type: CollectiveInterfaceType,
    description: 'Deactivate a collective as Host.',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'ID of the collective (Organization or User)',
      },
    },
    resolve(_, args, req) {
      checkRemoteUserCanUseHost(req);
      return deactivateCollectiveAsHost(_, args, req);
    },
  },
};

export default mutations;
