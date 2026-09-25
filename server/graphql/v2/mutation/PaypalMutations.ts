import config from 'config';
import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { SupportedCurrency } from '../../../constants/currencies';
import TwoFactorAuthLib from '../../../lib/two-factor-authentication';
import paypal, { connectPaypalPayoutMethod } from '../../../paymentProviders/paypal';
import { checkRemoteUserCanUseExpenses } from '../../common/scope-check';
import { Forbidden, NotFound, ValidationFailed } from '../../errors';
import { GraphQLCurrency } from '../enum/Currency';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { fetchPayoutMethodWithReference, GraphQLPayoutMethodReferenceInput } from '../input/PayoutMethodReferenceInput';
import { GraphQLConnectedAccount } from '../object/ConnectedAccount';
import GraphQLPayoutMethod from '../object/PayoutMethod';
import GraphQLURL from '../scalar/URL';

const assertPaypalConnectConfigured = (): void => {
  if (!config.paypal?.connect?.clientId) {
    throw new NotFound('PayPal Connect is not available at the moment.');
  }
};

const GraphQLPaypalConnectPayoutMethodResponse = new GraphQLObjectType({
  name: 'PaypalConnectPayoutMethodResponse',
  fields: {
    connectedAccount: {
      type: new GraphQLNonNull(GraphQLConnectedAccount),
      description: 'The connected account that was created for this PayPal login',
    },
    payoutMethod: {
      type: new GraphQLNonNull(GraphQLPayoutMethod),
      description: 'The payout method that was created or updated',
    },
  },
});

export const paypalMutations = {
  getPaypalOAuthUrl: {
    type: new GraphQLNonNull(GraphQLURL),
    description: 'Get the PayPal OAuth URL to initiate the "Log in with PayPal" payout method flow. Scope: "expenses".',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to connect a PayPal payout method for',
      },
      redirect: {
        type: GraphQLString,
        description: 'The URL or path to return to after the OAuth flow (stored in OAuth state)',
      },
      currency: {
        type: GraphQLCurrency,
        description: 'Currency for the payout method (stored in OAuth state)',
      },
    },
    resolve: async (
      _: void,
      args: { account: Record<string, unknown>; redirect?: string; currency?: string },
      req: express.Request,
    ): Promise<string> => {
      checkRemoteUserCanUseExpenses(req);
      assertPaypalConnectConfigured();

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Forbidden('You must be an admin of this collective');
      }

      await TwoFactorAuthLib.enforceForAccount(req, collective);

      return paypal.oauth.redirectUrl(req.remoteUser, collective.id, {
        redirect: args.redirect,
        currency: args.currency,
      });
    },
  },
  connectPaypalPayoutMethod: {
    type: new GraphQLNonNull(GraphQLPaypalConnectPayoutMethodResponse),
    description:
      'Complete the PayPal OAuth flow and create or update a verified PayPal payout method. Scope: "expenses".',
    args: {
      code: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The authorization code returned by PayPal in the OAuth callback',
      },
      state: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'The OAuth state token from the PayPal authorize URL',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account to connect a PayPal payout method for',
      },
      payoutMethod: {
        type: GraphQLPayoutMethodReferenceInput,
        description: 'When verifying an existing payout method, pass its reference here',
      },
      currency: {
        type: new GraphQLNonNull(GraphQLCurrency),
        description: 'Currency for the payout method',
      },
      name: {
        type: GraphQLString,
        description: 'A friendly name for the payout method',
      },
    },
    resolve: async (
      _: void,
      args: {
        code: string;
        state: string;
        account: Record<string, unknown>;
        payoutMethod?: { id: string };
        currency: SupportedCurrency;
        name?: string;
      },
      req: express.Request,
    ): Promise<{ connectedAccount: unknown; payoutMethod: unknown }> => {
      checkRemoteUserCanUseExpenses(req);
      assertPaypalConnectConfigured();

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Forbidden('You must be an admin of this collective');
      }

      await TwoFactorAuthLib.enforceForAccount(req, collective);

      let payoutMethod = null;
      if (args.payoutMethod?.id) {
        payoutMethod = await fetchPayoutMethodWithReference(args.payoutMethod, { loaders: req.loaders });
        if (!payoutMethod) {
          throw new NotFound('Payout method not found');
        }
      }

      if (!args.currency) {
        throw new ValidationFailed('Currency not provided');
      }

      const result = await connectPaypalPayoutMethod({
        remoteUser: req.remoteUser,
        collective,
        code: args.code,
        state: args.state,
        currency: args.currency,
        name: args.name,
        payoutMethod,
      });

      return result;
    },
  },
};
