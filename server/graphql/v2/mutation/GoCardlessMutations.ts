import { GraphQLNonNull, GraphQLString } from 'graphql';

import { hasFeature } from '../../../lib/allowed-features';
import {
  connectGoCardlessAccount,
  createGoCardlessLink,
  reconnectGoCardlessAccount,
} from '../../../lib/gocardless/connect';
import { syncGoCardlessAccount } from '../../../lib/gocardless/sync';
import RateLimit from '../../../lib/rate-limit';
import { reportErrorToSentry } from '../../../lib/sentry';
import { ConnectedAccount } from '../../../models';
import TransactionsImport, { TransactionsImportLockedError } from '../../../models/TransactionsImport';
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
      } else if (!(await hasFeature(host, 'OFF_PLATFORM_TRANSACTIONS', { loaders: req.loaders }))) {
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
      transactionImport: {
        type: GraphQLTransactionsImportReferenceInput,
        description: 'If re-connecting an existing account, the transactions import to reconnect',
      },
    },
    resolve: async (
      _,
      args: {
        host: { id: string };
        requisitionId: string;
        name?: string;
        sourceName?: string;
        transactionImport?: { id: string };
      },
      req,
    ) => {
      checkRemoteUserCanUseTransactions(req);
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden('You do not have permission to connect a GoCardless account');
      } else if (!(await hasFeature(host, 'OFF_PLATFORM_TRANSACTIONS', { loaders: req.loaders }))) {
        throw new Forbidden('Off-platform transactions are not enabled for this account');
      }

      const rateLimiter = new RateLimit(`connectGoCardlessAccount:${req.remoteUser.id}`, 20, 60 * 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded(
          'An account was already connected for this account recently. Please wait a few minutes before trying again.',
        );
      }

      let result: { connectedAccount: ConnectedAccount; transactionsImport: TransactionsImport };
      if (!args.transactionImport) {
        result = await connectGoCardlessAccount(req.remoteUser, host, args.requisitionId, {
          sourceName: args.sourceName,
          name: args.name,
        });

        // Asynchronously trigger a sync
        syncGoCardlessAccount(result.connectedAccount, result.transactionsImport, {
          full: true,
          retryFor: 30_000,
        }).catch(err => {
          if (!(err instanceof TransactionsImportLockedError)) {
            reportErrorToSentry(err, { req, extra: { args } });
          }
        });
      } else {
        const transactionsImport = await fetchTransactionsImportWithReference(args.transactionImport, {
          throwIfMissing: true,
        });

        const connectedAccount = await transactionsImport.getConnectedAccount();
        if (!connectedAccount) {
          throw new Error('Connected account not found for this transactions import');
        } else if (transactionsImport.CollectiveId !== host.id || connectedAccount.CollectiveId !== host.id) {
          throw new Forbidden('You do not have permission to reconnect this GoCardless account');
        }

        const lastSyncedTransactionDate = await transactionsImport.getLastSyncedTransactionDate();

        result = await reconnectGoCardlessAccount(
          req.remoteUser,
          connectedAccount,
          transactionsImport,
          args.requisitionId,
        );

        // Asynchronously trigger a sync
        syncGoCardlessAccount(result.connectedAccount, result.transactionsImport, {
          dateFrom: lastSyncedTransactionDate,
          retryFor: 30_000,
        }).catch(err => {
          if (!(err instanceof TransactionsImportLockedError)) {
            reportErrorToSentry(err, { req, extra: { args } });
          }
        });
      }

      return result;
    },
  },
};

export default goCardlessMutations;
