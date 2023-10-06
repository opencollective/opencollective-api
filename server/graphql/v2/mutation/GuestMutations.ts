import config from 'config';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { TOKEN_EXPIRATION_SESSION } from '../../../lib/auth';
import emailLib from '../../../lib/email';
import { confirmGuestAccountByEmail } from '../../../lib/guest-accounts';
import RateLimit from '../../../lib/rate-limit';
import models, { Collective } from '../../../models';
import { BadRequest, NotFound, RateLimitExceeded } from '../../errors';
import { GraphQLAccount } from '../interface/Account';
import GraphQLEmailAddress from '../scalar/EmailAddress';

const GraphQLConfirmGuestAccountResponse = new GraphQLObjectType({
  name: 'ConfirmGuestAccountResponse',
  description: 'Response for the confirmGuestAccount mutation',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'The validated account',
    },
    accessToken: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'A token that can be used to sign in',
    },
  }),
});

const guestMutations = {
  sendGuestConfirmationEmail: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Sends an email for guest to confirm their emails and create their Open Collective account',
    args: {
      email: {
        type: new GraphQLNonNull(GraphQLEmailAddress),
        description: 'The email to validate',
      },
    },
    async resolve(_: void, args: Record<string, unknown>, req: Record<string, unknown>): Promise<boolean> {
      // NOTE(oauth-scope): No scope needed

      // Only for unauthenticated users
      if (req.remoteUser) {
        throw new BadRequest(
          "You're signed in, which means your account is already verified. Sign out first if you want to verify another account.",
        );
      }

      // Make sure that this cannot be abused to guess email addresses
      const rateLimitOnIP = new RateLimit(
        `send_guest_confirm_ip_${req.ip}`,
        config.limits.sendGuestConfirmPerMinutePerIp,
        60,
      );

      if (!(await rateLimitOnIP.registerCall())) {
        throw new RateLimitExceeded('An email has already been sent recently. Please try again in a few minutes.');
      }

      // Make sure that we don't send more than one email per minute for each address
      const email = (<string>args.email).trim().toLowerCase();
      const rateLimitOnEmail = new RateLimit(
        `send_guest_confirm_email_${Buffer.from(email).toString('base64')}`,
        config.limits.sendGuestConfirmPerMinutePerEmail,
        60,
      );

      if (!(await rateLimitOnEmail.registerCall())) {
        throw new RateLimitExceeded(
          'An email has already been sent for this address recently. Please check your SPAM folder, or try again in a few minutes.',
        );
      }

      // Load data
      const user = await models.User.findOne({
        where: { email },
        include: [{ association: 'collective', required: true }],
      });

      if (!user) {
        throw new NotFound('No user found for this email address');
      } else if (user.confirmedAt) {
        throw new BadRequest('This account has already been confirmed');
      }

      // Send email
      const encodedEmail = encodeURIComponent(user.email);
      await emailLib.send(
        'confirm-guest-account',
        user.email,
        {
          email: user.email,
          verifyAccountLink: `${config.host.website}/confirm/guest/${user.emailConfirmationToken}?email=${encodedEmail}`,
          clientIp: req.ip,
        },
        { sendEvenIfNotProduction: true },
      );

      return true;
    },
  },
  confirmGuestAccount: {
    type: new GraphQLNonNull(GraphQLConfirmGuestAccountResponse),
    description: 'Mark an account as confirmed',
    args: {
      email: {
        type: new GraphQLNonNull(GraphQLEmailAddress),
        description: 'The email to confirm',
      },
      emailConfirmationToken: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The key that you want to edit in settings',
      },
    },
    async resolve(
      _: void,
      args: Record<string, unknown>,
      req: Record<string, unknown>,
    ): Promise<{ account: Collective; accessToken: string }> {
      // NOTE(oauth-scope): No scope needed

      // Adding a rate limite here to prevent attackers from guessing email addresses
      const rateLimitOnIP = new RateLimit(
        `confirm_guest_account_${req.ip}`,
        config.limits.confirmGuestAccountPerMinutePerIp,
        60,
      );

      if (!(await rateLimitOnIP.registerCall())) {
        throw new RateLimitExceeded();
      }

      const { user, collective } = await confirmGuestAccountByEmail(
        <string>args.email,
        <string>args.emailConfirmationToken,
      );

      const accessToken = user.jwt({}, TOKEN_EXPIRATION_SESSION);
      return { account: collective, accessToken };
    },
  },
};

export default guestMutations;
