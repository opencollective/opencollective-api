import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { sessionCache } from '../../../lib/cache';
import logger from '../../../lib/logger';
import TwoFactorAuthLib from '../../../lib/two-factor-authentication';
import transferwise from '../../../paymentProviders/transferwise';
import { checkRemoteUserCanUseConnectedAccounts } from '../../common/scope-check';
import { Forbidden, NotFound } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLConnectedAccount } from '../object/ConnectedAccount';
import GraphQLURL from '../scalar/URL';

const GraphQLTransferwiseConnectAccountResponse = new GraphQLObjectType({
  name: 'TransferwiseConnectAccountResponse',
  fields: {
    connectedAccount: {
      type: new GraphQLNonNull(GraphQLConnectedAccount),
      description: 'The connected account that was created',
    },
    redirectUrl: {
      type: GraphQLURL,
      description: 'The URL to redirect the user to once the connection is complete',
    },
  },
});

export const transferwiseMutations = {
  getTransferwiseOAuthUrl: {
    type: new GraphQLNonNull(GraphQLURL),
    description:
      'Get the Wise (TransferWise) OAuth URL to initiate the account connection flow for a host. Scope: "connectedAccounts".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host account to connect Wise to',
      },
      redirect: {
        type: GraphQLString,
        description: 'The URL or path to redirect the user to once the OAuth flow is complete',
      },
    },
    resolve: async (
      _: void,
      args: { account: Record<string, unknown>; redirect?: string },
      req: express.Request,
    ): Promise<string> => {
      checkRemoteUserCanUseConnectedAccounts(req);

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdmin(collective.id)) {
        throw new Forbidden('You must be an admin of this account to connect a Wise account.');
      }

      // We call it here to avoid calling it again in the callback resolver.
      await TwoFactorAuthLib.enforceForAccount(req, collective);

      return transferwise.oauth.redirectUrl(req.remoteUser, collective.id, { redirect: args.redirect });
    },
  },
  connectTransferwiseAccount: {
    type: new GraphQLNonNull(GraphQLTransferwiseConnectAccountResponse),
    description:
      'Complete the Wise (TransferWise) OAuth flow and connect the account to the host. Scope: "connectedAccounts".',
    args: {
      code: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The authorization code returned by Wise in the OAuth callback',
      },
      profileId: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The Wise profile id returned in the OAuth callback',
      },
      state: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The OAuth state token that was generated when initiating the connection',
      },
    },
    resolve: async (
      _: void,
      args: { code: string; profileId: string; state: string },
      req: express.Request,
    ): Promise<{ connectedAccount: unknown; redirectUrl?: string }> => {
      checkRemoteUserCanUseConnectedAccounts(req);

      const cacheKey = `transferwise_oauth_${args.state}`;
      const originalRequest = await sessionCache.get(cacheKey);
      if (!originalRequest) {
        throw new NotFound('This Wise connection request could not be found or has expired. Please try again.');
      }

      const { redirect, CollectiveId, UserId: CreatedByUserId } = originalRequest;
      if (!CreatedByUserId || CreatedByUserId !== req.remoteUser.id || !req.remoteUser.isAdmin(CollectiveId)) {
        throw new Forbidden('You do not have permission to complete this Wise connection');
      }

      const collective = await fetchAccountWithReference(
        { legacyId: CollectiveId },
        { loaders: req.loaders, throwIfMissing: true },
      );
      await TwoFactorAuthLib.enforceForAccount(req, collective);
      try {
        const connectedAccount = await transferwise.connectTransferwiseAccount({
          code: args.code,
          profileId: args.profileId,
          CollectiveId,
          CreatedByUserId,
        });

        // Clear cached authorization state key so it can't be replayed
        await sessionCache.delete(cacheKey);

        return { connectedAccount, redirectUrl: redirect };
      } catch (e) {
        logger.error(`Error with Wise OAuth callback: ${e.message}`, { state: args.state });
        await sessionCache.delete(cacheKey);
        throw e;
      }
    },
  },
};
