import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLLocale } from 'graphql-scalars';
import { isEmpty, pick } from 'lodash';

import { Service } from '../../../constants/connected-account';
import { hasFeature } from '../../../lib/allowed-features';
import { connectPlaidAccount, generatePlaidLinkToken, refreshPlaidSubAccounts } from '../../../lib/plaid/connect';
import { requestPlaidAccountSync } from '../../../lib/plaid/sync';
import RateLimit from '../../../lib/rate-limit';
import { ConnectedAccount, TransactionsImport } from '../../../models';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { Forbidden, RateLimitExceeded } from '../../errors';
import { GraphQLCountryISO } from '../enum';
import {
  AccountReferenceInput,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import {
  fetchConnectedAccountWithReference,
  GraphQLConnectedAccountReferenceInput,
} from '../input/ConnectedAccountReferenceInput';
import {
  fetchTransactionsImportWithReference,
  GraphQLTransactionsImportReferenceInput,
  GraphQLTransactionsImportReferenceInputFields,
} from '../input/TransactionsImportReferenceInput';
import { GraphQLConnectedAccount } from '../object/ConnectedAccount';
import { GraphQLTransactionsImport } from '../object/TransactionsImport';

const GraphQLPlaidLinkTokenCreateResponse = new GraphQLObjectType({
  name: 'PlaidLinkTokenCreateResponse',
  fields: {
    linkToken: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The link token that will be used to initialize the Plaid Link flow.',
    },
    expiration: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The expiration date for the link token in ISO 8601 format.',
    },
    requestId: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'A unique identifier for the request, which can be used for troubleshooting.',
    },
    hostedLinkUrl: {
      type: GraphQLString,
      description:
        'A URL of a Plaid-hosted Link flow that will use the Link token returned by this request. Only present if the client is enabled for Host',
    },
  },
});

const GraphQLPlaidConnectAccountResponse = new GraphQLObjectType({
  name: 'PlaidConnectAccountResponse',
  fields: {
    connectedAccount: {
      type: new GraphQLNonNull(GraphQLConnectedAccount),
      description: 'The connected account that was created',
    },
    transactionsImport: {
      type: new GraphQLNonNull(GraphQLTransactionsImport),
      description: 'The transactions import that was created',
    },
  },
});

export const plaidMutations = {
  generatePlaidLinkToken: {
    type: new GraphQLNonNull(GraphQLPlaidLinkTokenCreateResponse),
    description: 'Generate a Plaid Link token',
    args: {
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to which the Plaid account should be connected',
      },
      transactionImport: {
        type: GraphQLTransactionsImportReferenceInput,
        description: 'Use this parameter to specify the import to update (when using the Plaid update flow)',
      },
      countries: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLCountryISO)),
        description: 'The countries to enable in the accounts selection. Defaults to the host country.',
      },
      locale: {
        type: GraphQLLocale,
        description: 'The language to use in the Plaid Link flow. Defaults to "en".',
      },
      accountSelectionEnabled: {
        type: GraphQLBoolean,
        description: 'If true, the account selection flow will be enabled. Requires a `transactionImport`.',
      },
    },
    resolve: async (_, args, req: Express.Request) => {
      checkRemoteUserCanUseTransactions(req);

      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden('You do not have permission to connect a Plaid account for this host');
      } else if (!hasFeature(host, 'OFF_PLATFORM_TRANSACTIONS')) {
        throw new Forbidden('Off-platform transactions are not enabled for this account');
      }

      const rateLimiter = new RateLimit(`generatePlaidLinkToken:${req.remoteUser.id}`, 10, 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded(
          'A sync was already requested for this account recently. Please wait a few minutes before trying again.',
        );
      }

      const params: Parameters<typeof generatePlaidLinkToken>[1] = {
        products: ['auth', 'transactions'],
        countries: isEmpty(args.countries) ? ['US'] : args.countries,
        locale: args.locale || 'en',
        accountSelectionEnabled: args.accountSelectionEnabled,
      };

      if (args.transactionImport) {
        const transactionImport = await fetchTransactionsImportWithReference(args.transactionImport, {
          throwIfMissing: true,
        });
        if (transactionImport.CollectiveId !== host.id) {
          throw new Forbidden('You do not have permission to update this import');
        }

        const connectedAccount = await transactionImport.getConnectedAccount();
        if (!connectedAccount) {
          throw new Error('Connected account not found');
        } else if (connectedAccount.CollectiveId !== host.id) {
          throw new Forbidden('You do not have permission to update the connection for this import');
        }

        params.accessToken = connectedAccount.token;
      }

      const tokenData = await generatePlaidLinkToken(req.remoteUser, params);

      return {
        linkToken: tokenData['link_token'],
        expiration: tokenData['expiration'],
        requestId: tokenData['request_id'],
        hostedLinkUrl: tokenData['hosted_link_url'],
      };
    },
  },
  connectPlaidAccount: {
    type: new GraphQLNonNull(GraphQLPlaidConnectAccountResponse),
    description: 'Connect a Plaid account',
    args: {
      publicToken: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The public token returned by the Plaid Link flow',
      },
      host: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to which the Plaid account should be connected',
      },
      sourceName: {
        type: GraphQLString,
        description: 'The name of the bank',
      },
      name: {
        type: GraphQLString,
        description: 'The name of the bank account',
      },
    },
    resolve: async (
      _,
      args: {
        host: AccountReferenceInput;
        transactionImport: GraphQLTransactionsImportReferenceInputFields;
        publicToken: string;
        sourceName?: string;
        name?: string;
      },
      req,
    ) => {
      checkRemoteUserCanUseTransactions(req);
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(host)) {
        throw new Forbidden('You do not have permission to connect a Plaid account');
      }

      const rateLimiter = new RateLimit(`connectPlaidAccount:${req.remoteUser.id}`, 20, 60 * 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded(
          'A sync was already requested for this account recently. Please wait a few minutes before trying again.',
        );
      }

      const accountInfo: Parameters<typeof connectPlaidAccount>[3] = pick(args, ['sourceName', 'name']);
      return connectPlaidAccount(req.remoteUser, host, args.publicToken, accountInfo);
    },
  },
  syncPlaidAccount: {
    type: new GraphQLNonNull(GraphQLTransactionsImport),
    description: 'Manually request a sync for Plaid account',
    deprecationReason: '2025-07-23: Use `syncTransactionsImport` instead',
    args: {
      connectedAccount: {
        type: new GraphQLNonNull(GraphQLConnectedAccountReferenceInput),
        description: 'The connected account to refresh',
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseTransactions(req);
      const connectedAccount = await fetchConnectedAccountWithReference(args.connectedAccount, {
        throwIfMissing: true,
      });
      if (!req.remoteUser.isAdmin(connectedAccount.CollectiveId)) {
        throw new Forbidden('You do not have permission to sync this account');
      }

      const rateLimiter = new RateLimit(`syncPlaidAccount:${connectedAccount.id}`, 2, 5 * 60);
      if (!(await rateLimiter.registerCall())) {
        throw new RateLimitExceeded(
          'A sync was already requested for this account recently. Please wait a few minutes before trying again.',
        );
      }

      await requestPlaidAccountSync(connectedAccount);
      return connectedAccount;
    },
  },
  refreshPlaidAccount: {
    type: new GraphQLNonNull(GraphQLPlaidConnectAccountResponse),
    description: 'Refresh the list of sub-accounts & other metadata by re-fetching the account info',
    args: {
      connectedAccount: {
        type: GraphQLConnectedAccountReferenceInput,
        description: 'The Plaid connected account to refresh',
      },
      transactionImport: {
        type: GraphQLTransactionsImportReferenceInput,
        description: 'The transactions import to refresh',
      },
    },
    resolve: async (_, args, req) => {
      checkRemoteUserCanUseTransactions(req);

      let transactionsImport: TransactionsImport | null = null;
      let connectedAccount: ConnectedAccount | null = null;

      if (args.transactionImport) {
        transactionsImport = await fetchTransactionsImportWithReference(args.transactionImport, {
          throwIfMissing: true,
        });
        if (transactionsImport) {
          connectedAccount = await transactionsImport.getConnectedAccount();
        }
      } else if (args.connectedAccount) {
        connectedAccount = await fetchConnectedAccountWithReference(args.connectedAccount, {
          throwIfMissing: true,
        });

        transactionsImport = await TransactionsImport.findOne({
          where: { ConnectedAccountId: connectedAccount.id },
        });
      } else {
        throw new Error('You must provide either a transaction import or a connected account');
      }

      if (!transactionsImport || !connectedAccount) {
        throw new Error('Transactions import not found');
      } else if (!req.remoteUser.isAdmin(connectedAccount.CollectiveId)) {
        throw new Forbidden('You do not have permission to refresh this account');
      } else if (connectedAccount.service !== Service.PLAID) {
        throw new Forbidden('This account is not a Plaid account');
      }

      await refreshPlaidSubAccounts(connectedAccount, transactionsImport);
      return { connectedAccount, transactionsImport };
    },
  },
};
