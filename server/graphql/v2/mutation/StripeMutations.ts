import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';
import assert from 'node:assert';

import { CollectiveType } from '../../../constants/collectives';
import { sessionCache } from '../../../lib/cache';
import logger from '../../../lib/logger';
import TwoFactorAuthLib from '../../../lib/two-factor-authentication';
import { Collective } from '../../../models';
import stripe, { STATE_CACHE_PREFIX } from '../../../paymentProviders/stripe';
import { checkRemoteUserCanUseConnectedAccounts } from '../../common/scope-check';
import { Forbidden, NotFound } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLConnectedAccount } from '../object/ConnectedAccount';
import GraphQLURL from '../scalar/URL';

const assertCanConnectStripe = (account: Collective) => {
  assert(account.type === CollectiveType.ORGANIZATION, 'Stripe accounts can only be linked to organizations');
  assert(
    account.hasMoneyManagement,
    'Stripe accounts can only be linked to organizations with money management enabled',
  );
};

const GraphQLStripeConnectAccountResponse = new GraphQLObjectType({
  name: 'StripeConnectAccountResponse',
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

export const stripeMutations = {
  getStripeOAuthUrl: {
    type: new GraphQLNonNull(GraphQLURL),
    description:
      'Get the Stripe OAuth URL to initiate the account connection flow for a host. Scope: "connectedAccounts".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The host account to connect Stripe to',
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

      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdmin(account.id)) {
        throw new Forbidden('You must be an admin of this account to connect a Stripe account.');
      }
      assertCanConnectStripe(account);

      // We call it here to avoid calling it again in the callback resolver.
      await TwoFactorAuthLib.enforceForAccount(req, account, { alwaysAskForToken: true });

      return stripe.oauth.redirectUrl(req.remoteUser, account.id, { redirect: args.redirect });
    },
  },
  connectStripeAccount: {
    type: new GraphQLNonNull(GraphQLStripeConnectAccountResponse),
    description: 'Complete the Stripe OAuth flow and connect the account to the host. Scope: "connectedAccounts".',
    args: {
      code: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The authorization code returned by Stripe in the OAuth callback',
      },
      state: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The OAuth state token that was generated when initiating the connection',
      },
    },
    resolve: async (
      _: void,
      args: { code: string; state: string },
      req: express.Request,
    ): Promise<{ connectedAccount: unknown; redirectUrl?: string }> => {
      checkRemoteUserCanUseConnectedAccounts(req);

      const cacheKey = `${STATE_CACHE_PREFIX}${args.state}`;
      const originalRequest = await sessionCache.get(cacheKey);
      if (!originalRequest) {
        throw new NotFound('This Stripe connection request could not be found or has expired. Please try again.');
      }

      const { redirect, CollectiveId, UserId: CreatedByUserId } = originalRequest;
      if (!CreatedByUserId || CreatedByUserId !== req.remoteUser.id || !req.remoteUser.isAdmin(CollectiveId)) {
        throw new Forbidden('You do not have permission to complete this Stripe connection');
      }

      const account = await fetchAccountWithReference(
        { legacyId: CollectiveId },
        { loaders: req.loaders, throwIfMissing: true },
      );
      assertCanConnectStripe(account);

      await TwoFactorAuthLib.enforceForAccount(req, account);

      try {
        const connectedAccount = await stripe.connectStripeAccount({
          code: args.code,
          CollectiveId,
          CreatedByUserId,
        });

        await sessionCache.delete(cacheKey);
        return { connectedAccount, redirectUrl: redirect };
      } catch (e) {
        logger.error(`Error with Stripe OAuth callback: ${e.message}`, { state: args.state });
        await sessionCache.delete(cacheKey);
        throw e;
      }
    },
  },
};
