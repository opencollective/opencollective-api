import assert from 'assert';

import bcrypt from 'bcrypt';
import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';

import * as auth from '../../../lib/auth';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import TwoFactorAuthLib from '../../../lib/two-factor-authentication';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { confirmUserEmail } from '../../common/user';
import { RateLimitExceeded, Unauthorized } from '../../errors';
import { GraphQLIndividual } from '../object/Individual';
import { GraphQLSetPasswordResponse } from '../object/SetPasswordResponse';

const individualMutations = {
  setChangelogViewDate: {
    type: new GraphQLNonNull(GraphQLIndividual),
    description: 'Update the time which the user viewed the changelog updates. Scope: "account".',
    args: {
      changelogViewDate: {
        type: new GraphQLNonNull(GraphQLDateTime),
      },
    },
    resolve: async (_, { changelogViewDate }, req) => {
      checkRemoteUserCanUseAccount(req);

      const user = await req.remoteUser.update({ changelogViewDate: changelogViewDate });
      return user.getCollective({ loaders: req.loaders });
    },
  },
  setNewsletterOptIn: {
    type: new GraphQLNonNull(GraphQLIndividual),
    description: 'Update newsletter opt-in preference. Scope: "account".',
    args: {
      newsletterOptIn: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
    resolve: async (_, { newsletterOptIn }, req) => {
      checkRemoteUserCanUseAccount(req);

      const user = await req.remoteUser.update({ newsletterOptIn });
      return user.getCollective({ loaders: req.loaders });
    },
  },
  setPassword: {
    type: new GraphQLNonNull(GraphQLSetPasswordResponse),
    description: 'Set password to Individual. Scope: "account". 2FA.',
    args: {
      password: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The password to set.',
      },
      currentPassword: {
        type: GraphQLString,
        description: 'The current password (if any) to confirm password change.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseAccount(req);

      const rateLimitKey = `individual_set_password_${req.remoteUser.id}`;
      const rateLimitMax = config.limits.setPasswordPerUserPerHour;
      const rateLimit = new RateLimit(rateLimitKey, rateLimitMax, ONE_HOUR_IN_SECONDS);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      // Enforce 2FA
      const account = await req.remoteUser.getCollective({ loaders: req.loaders });
      await TwoFactorAuthLib.enforceForAccount(req, account, { alwaysAskForToken: true });

      if (req.jwtPayload?.scope === 'reset-password') {
        // If resetting with a reset token, the email must match
        assert(req.jwtPayload['email'] === req.remoteUser.email, 'This token has expired');
      } else if (req.remoteUser.passwordHash) {
        // Check current password if one already set
        if (!args.currentPassword) {
          throw new Unauthorized('Submit current password to change password.');
        }
        const validPassword = await bcrypt.compare(args.currentPassword, req.remoteUser.passwordHash);
        if (!validPassword) {
          throw new Unauthorized('Invalid current password while attempting to change password.');
        }
      }

      // If we're there, it's a success, we can reset the rate limit count
      await rateLimit.reset();

      const user = await req.remoteUser.setPassword(args.password, { userToken: req.userToken });
      const individual = await user.getCollective({ loaders: req.loaders });

      let token;

      // We don't want OAuth/Personal tokens to be exchanged against a session token
      if (!req.userToken && !req.personalToken) {
        // Context: this is token generation when updating password
        token = await user.generateSessionToken({
          sessionId: req.jwtPayload?.sessionId,
          createActivity: false,
          updateLastLoginAt: false,
        });
        auth.setAuthCookie(req.res, token);
      }

      return { individual, token };
    },
  },
  confirmEmail: {
    description: 'Confirm email for Individual. Scope: "account".',
    type: new GraphQLNonNull(
      new GraphQLObjectType({
        name: 'IndividualConfirmEmailResponse',
        fields: {
          individual: {
            type: new GraphQLNonNull(GraphQLIndividual),
            description: 'The account that was confirmed',
          },
          sessionToken: {
            type: GraphQLString,
            description: 'A new session token to use for the account. Only returned if user is signed in already.',
          },
        },
      }),
    ),
    args: {
      token: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The token to confirm the email.',
      },
    },
    resolve: async (_, { token: confirmEmailToken }, req) => {
      // Forbid this route for OAuth and Personal Tokens. Remember to check the scope if you want to allow it.
      // Also make sure to prevent exchanging OAuth/Personal tokens for session tokens.
      if (req.userToken || req.personalToken) {
        throw new Unauthorized('OAuth and Personal Tokens are not allowed for this route');
      }

      // Rate limit (by IP, since we support anonymous requests)
      const rateLimitKey = `individual_confirm_email_ip_${req.ip}`;
      const rateLimitMax = config.limits.confirmEmailPerIpPerHour;
      const rateLimit = new RateLimit(rateLimitKey, rateLimitMax, ONE_HOUR_IN_SECONDS);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      // Confirm email
      const user = await confirmUserEmail(confirmEmailToken);
      const individual = await user.getCollective({ loaders: req.loaders });

      // The sign-in token
      let sessionToken;

      // Re-generate the session token if the user is already signed in
      if (req.remoteUser && req.remoteUser.id === user.id) {
        sessionToken = await user.generateSessionToken({
          sessionId: req.jwtPayload?.sessionId,
          createActivity: false,
          updateLastLoginAt: false,
        });
        auth.setAuthCookie(req.res, sessionToken);
      }

      return { individual, sessionToken };
    },
  },
};

export default individualMutations;
