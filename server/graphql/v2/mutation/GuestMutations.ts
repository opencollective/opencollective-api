import config from 'config';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { TOKEN_EXPIRATION_SESSION } from '../../../lib/auth';
import { confirmGuestAccountByEmail } from '../../../lib/guest-accounts';
import RateLimit from '../../../lib/rate-limit';
import { Collective } from '../../../models';
import { RateLimitExceeded } from '../../errors';
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
