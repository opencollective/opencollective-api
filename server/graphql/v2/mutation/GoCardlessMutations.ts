import { GraphQLNonNull, GraphQLString } from 'graphql';

import { hasFeature } from '../../../lib/allowed-features';
import { connectGoCardlessAccount, createGoCardlessLink } from '../../../lib/gocardless/connect';
import { syncGoCardlessAccount } from '../../../lib/gocardless/sync';
import RateLimit from '../../../lib/rate-limit';
import { reportErrorToSentry } from '../../../lib/sentry';
import { TransactionsImportLockedError } from '../../../models/TransactionsImport';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLGoCardlessLinkInput } from '../input/GoCardlessLinkInput';
import { GraphQLGoCardlessConnectAccountResponse } from '../object/GoCardlessConnectAccountResponse';
import { GraphQLGoCardlessLink } from '../object/GoCardlessLink';

const goCardlessMutations = {
  generateGoCardlessLink: {
    type: new GraphQLNonNull(GraphQLGoCardlessLink),
    description: 'Generate a GoCardless link for bank account data access',
    args: {
      input: {
        type: new GraphQLNonNull(GraphQLGoCardlessLinkInput),
        description: 'Input for creating the GoCardless link',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to which the GoCardless link should be generated',
      },
    },
    resolve: async (_: void, args, req: Express.Request) => {
      checkRemoteUserCanUseTransactions(req);

      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden('You do not have permission to generate a GoCardless link');
      } else if (!hasFeature(host, 'OFF_PLATFORM_TRANSACTIONS')) {
        throw new Forbidden('Off-platform transactions are not enabled for this account');
      }

      const rateLimiter = new RateLimit(`generateGoCardlessLink:${req.remoteUser.id}`, 20, 60 * 60);
      if (await rateLimiter.hasReachedLimit()) {
        throw new RateLimitExceeded(
          'A link was already generated for this account recently. Please wait a few minutes before trying again.',
        );
      }

      const { input } = args;

      // Create the GoCardless link
      const link = await createGoCardlessLink(input.institutionId, {
        maxHistoricalDays: input.maxHistoricalDays,
        accessValidForDays: input.accessValidForDays,
        userLanguage: input.userLanguage,
        accountSelection: input.accountSelection,
      });

      await rateLimiter.registerCall();

      return {
        id: link.id,
        createdAt: new Date(link.created),
        redirect: link.redirect,
        institutionId: link.institution_id,
        link: link.link,
        reference: link.reference,
      };
    },
  },
  connectGoCardlessAccount: {
    type: new GraphQLNonNull(GraphQLGoCardlessConnectAccountResponse),
    description: 'Connect a GoCardless account',
    args: {
      requisitionId: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The requisition ID returned by the GoCardless flow',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to which the GoCardless account should be connected',
      },
      sourceName: {
        type: GraphQLString,
        description: 'The name of the institution',
      },
      name: {
        type: GraphQLString,
        description: 'The name of the account. Will be inferred if not provided.',
      },
    },
    resolve: async (
      _,
      args: {
        host: { id: string };
        requisitionId: string;
        name?: string;
        sourceName?: string;
      },
      req,
    ) => {
      checkRemoteUserCanUseTransactions(req);
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden('You do not have permission to connect a GoCardless account');
      } else if (!hasFeature(host, 'OFF_PLATFORM_TRANSACTIONS')) {
        throw new Forbidden('Off-platform transactions are not enabled for this account');
      }

      const rateLimiter = new RateLimit(`connectGoCardlessAccount:${req.remoteUser.id}`, 20, 60 * 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded(
          'An account was already connected for this account recently. Please wait a few minutes before trying again.',
        );
      }

      const result = await connectGoCardlessAccount(req.remoteUser, host, args.requisitionId, {
        sourceName: args.sourceName,
        name: args.name,
      });

      // Asynchronously trigger a sync
      syncGoCardlessAccount(result.connectedAccount, result.transactionsImport, { full: true, retryFor: 30_000 }).catch(
        err => {
          if (!(err instanceof TransactionsImportLockedError)) {
            reportErrorToSentry(err, { req, extra: { args } });
          }
        },
      );

      return result;
    },
  },
};

export default goCardlessMutations;
