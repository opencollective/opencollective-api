import { GraphQLNonNull, GraphQLString } from 'graphql';

import { connectGoCardlessAccount } from '../../../lib/gocardless/connect';
import RateLimit from '../../../lib/rate-limit';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import {
  fetchTransactionsImportWithReference,
  GraphQLTransactionsImportReferenceInput,
} from '../input/TransactionsImportReferenceInput';
import { GraphQLGoCardlessConnectAccountResponse } from '../object/GoCardlessConnectAccountResponse';

const goCardlessMutations = {
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
    },
    resolve: async (
      _,
      args: {
        host: { id: string };
        requisitionId: string;
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

      return connectGoCardlessAccount(req.remoteUser, host, args.requisitionId);
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
