import { GraphQLNonNull, GraphQLString } from 'graphql';

import { connectGoCardlessAccount, createGoCardlessLink } from '../../../lib/gocardless/connect';
import { syncGoCardlessAccount } from '../../../lib/gocardless/sync';
import RateLimit from '../../../lib/rate-limit';
import { reportErrorToSentry } from '../../../lib/sentry';
import { TransactionsImportLockedError } from '../../../models/TransactionsImport';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLGoCardlessLinkInput } from '../input/GoCardlessLinkInput';
import {
  fetchTransactionsImportWithReference,
  GraphQLTransactionsImportReferenceInput,
} from '../input/TransactionsImportReferenceInput';
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
    },
    resolve: async (_: void, args, req: Express.Request) => {
      checkRemoteUserCanUseTransactions(req);

      // TODO: make sure the user has feature access

      const rateLimiter = new RateLimit(`generateGoCardlessLink:${req.remoteUser.id}`, 20, 60 * 60);
      if (!(await rateLimiter.registerCall())) {
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
      }

      const rateLimiter = new RateLimit(`connectGoCardlessAccount:${req.remoteUser.id}`, 20, 60 * 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded(
          'A sync was already requested for this account recently. Please wait a few minutes before trying again.',
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
  refreshGoCardlessAccount: {
    type: new GraphQLNonNull(GraphQLGoCardlessConnectAccountResponse),
    description: 'Refresh the GoCardless account data',
    args: {
      transactionImport: {
        type: new GraphQLNonNull(GraphQLTransactionsImportReferenceInput),
        description: 'The transactions import to refresh',
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseTransactions(req);

      const transactionsImport = await fetchTransactionsImportWithReference(args.transactionImport, {
        throwIfMissing: true,
      });

      if (!req.remoteUser.isAdminOfCollective(transactionsImport.collective)) {
        throw new Forbidden('You do not have permission to refresh this account');
      }

      const rateLimiter = new RateLimit(`refreshGoCardlessAccount:${transactionsImport.id}`, 2, 5 * 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded(
          'A sync was already requested for this account recently. Please wait a few minutes before trying again.',
        );
      }

      // TODO: Implement the actual GoCardless refresh logic
      // await refreshGoCardlessAccount(transactionsImport);

      throw new Error('GoCardless refresh not yet implemented');
    },
  },
};

export default goCardlessMutations;
