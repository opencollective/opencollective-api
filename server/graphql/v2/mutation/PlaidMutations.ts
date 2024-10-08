import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import { connectPlaidAccount, generatePlaidLinkToken } from '../../../lib/plaid/connect';
import { checkRemoteUserCanRoot } from '../../common/scope-check';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
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
    resolve: async (_, _args, req) => {
      checkRemoteUserCanRoot(req);
      const tokenData = await generatePlaidLinkToken(req.remoteUser, ['auth', 'transactions'], ['US']);
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
    resolve: async (_, args, req) => {
      checkRemoteUserCanRoot(req);
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      const accountInfo = pick(args, ['sourceName', 'name']);
      return connectPlaidAccount(req.remoteUser, host, args.publicToken, accountInfo);
    },
  },
};
