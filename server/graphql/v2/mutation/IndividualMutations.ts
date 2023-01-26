import bcrypt from 'bcrypt';
import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import activities from '../../../constants/activities';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../lib/rate-limit';
import TwoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { RateLimitExceeded, Unauthorized } from '../../errors';
import { Individual } from '../object/Individual';

const individualMutations = {
  setChangelogViewDate: {
    type: new GraphQLNonNull(Individual),
    description: 'Update the time which the user viewed the changelog updates. Scope: "account".',
    args: {
      changelogViewDate: {
        type: new GraphQLNonNull(GraphQLDateTime),
      },
    },
    resolve: async (_, { changelogViewDate }, req) => {
      checkRemoteUserCanUseAccount(req);

      const user = await req.remoteUser.update({ changelogViewDate: changelogViewDate });
      return user.getCollective();
    },
  },
  setNewsletterOptIn: {
    type: new GraphQLNonNull(Individual),
    description: 'Update newsletter opt-in preference. Scope: "account".',
    args: {
      newsletterOptIn: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
    resolve: async (_, { newsletterOptIn }, req) => {
      checkRemoteUserCanUseAccount(req);

      const user = await req.remoteUser.update({ newsletterOptIn });
      return user.getCollective();
    },
  },
  setPassword: {
    type: new GraphQLNonNull(Individual),
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

      const rateLimit = new RateLimit(`individual_set_password_${req.remoteUser.id}`, 10, ONE_HOUR_IN_SECONDS, true);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      // Enforce 2FA
      const account = await req.remoteUser.getCollective();
      await TwoFactorAuthLib.enforceForAccountAdmins(req, account, { alwaysAskForToken: true });

      // Check current password if one already set
      if (req.remoteUser.passwordHash) {
        if (!args.currentPassword) {
          throw new Unauthorized('Submit current password to change password.');
        }
        const validPassword = await bcrypt.compare(args.currentPassword, req.remoteUser.passwordHash);
        if (!validPassword) {
          return new Unauthorized('Invalid current password while attempting to change password.');
        }
      }

      // If we're there, it's a success, we can reset the rate limit count
      await rateLimit.reset();

      // TODO: extract saltRounds in some configuration or shared library
      const passwordHash = await bcrypt.hash(args.password, /* saltRounds */ 10);
      const user = await req.remoteUser.update({ passwordHash });

      await models.Activity.create({
        type: activities.USER_PASSWORD_SET,
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: user.CollectiveId,
        UserTokenId: req.userToken?.id,
      });

      return user.getCollective();
    },
  },
};

export default individualMutations;
