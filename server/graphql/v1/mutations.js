import config from 'config';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { checkCaptcha, isCaptchaSetup } from '../../lib/check-captcha';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../lib/rate-limit';
import { reportMessageToSentry } from '../../lib/sentry';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import { parseToBoolean } from '../../lib/utils';
import models from '../../models';
import { checkCanEditTeam } from '../common/members';
import { checkRemoteUserCanUseAccount, checkRemoteUserCanUseOrders } from '../common/scope-check';
import { createUser } from '../common/user';
import { NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../errors';

import { createCollective, editCollective } from './mutations/collectives';
import * as paymentMethodsMutation from './mutations/paymentMethods';
import { CollectiveInterfaceType } from './CollectiveInterface';
import {
  CaptchaInputType,
  CollectiveInputType,
  MemberInputType,
  StripeCreditCardDataInputType,
  UserInputType,
} from './inputTypes';
import { PaymentMethodType, UserType } from './types';

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

      // An explicitly provided `null` overrides the GraphQL default, so normalize it to the documented default.
      const throwIfExists = args.throwIfExists ?? true;

      // Cypress E2E helpers lazily create fixture users through this mutation with
      // `throwIfExists: false`. Keep that convenience in E2E/development stacks only:
      // in staging/production it would let an anonymous caller act on an existing account.
      // Unit tests do not set `E2E_TEST`, so they still exercise the production behavior.
      const allowLegacyUserAdoption =
        !['staging', 'production'].includes(config.env) &&
        (parseToBoolean(process.env.E2E_TEST) || config.env === 'development');

      // `throwIfExists: false` (get-or-create) is only allowed for the authenticated owner of the email.
      // Otherwise, an anonymous caller could act on behalf of an existing account.
      if (throwIfExists === false && !allowLegacyUserAdoption && args.user.email) {
        const existingUser = await models.User.findOne({ where: { email: args.user.email.toLowerCase().trim() } });
        if (existingUser && existingUser.id !== remoteUser?.id) {
          throw new ValidationFailed(
            'It looks like that email already exists, please sign in instead',
            'EMAIL_ALREADY_EXISTS',
          );
        }
      }

      return createUser(args.user, {
        organizationData: args.organization,
        sendSignInLink: args.sendSignInLink,
        throwIfExists,
        redirect: args.redirect,
        websiteUrl: args.websiteUrl,
        creationRequest: {
          ip: req.ip,
          userAgent: req.header('user-agent'),
        },
      });
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
        await checkCanEditTeam(collective, req);
        await twoFactorAuthLib.enforceForAccount(req, collective, { onlyAskOnLogin: true });

        await collective.editMembers(args.members, {
          CreatedByUserId: req.remoteUser.id,
          remoteUserCollectiveId: req.remoteUser.CollectiveId,
        });
        return collective;
      }
    },
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
};

export default mutations;
