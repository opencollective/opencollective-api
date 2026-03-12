import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import { Service } from '../../../constants/connected-account';
import FEATURE from '../../../constants/feature';
import { checkFeatureAccess, getErrorMessageFromFeatureAccess, getFeatureAccess } from '../../../lib/allowed-features';
import { crypto } from '../../../lib/encryption';
import { disconnectGoCardlessAccount } from '../../../lib/gocardless/connect';
import { personaKycProvider } from '../../../lib/kyc/providers/persona';
import * as paypal from '../../../lib/paypal';
import { disconnectPlaidAccount } from '../../../lib/plaid/connect';
import * as transferwise from '../../../lib/transferwise';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import type { ConnectedAccount as ConnectedAccountModel } from '../../../models';
import models from '../../../models';
import { checkRemoteUserCanUseConnectedAccounts } from '../../common/scope-check';
import { Forbidden, Unauthorized, ValidationFailed } from '../../errors';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLConnectedAccountCreateInput } from '../input/ConnectedAccountCreateInput';
import {
  fetchConnectedAccountWithReference,
  GraphQLConnectedAccountReferenceInput,
} from '../input/ConnectedAccountReferenceInput';
import { GraphQLConnectedAccount } from '../object/ConnectedAccount';

const connectedAccountMutations = {
  createConnectedAccount: {
    type: GraphQLConnectedAccount,
    description: 'Connect external account to Open Collective Account. Scope: "connectedAccounts".',
    args: {
      connectedAccount: {
        type: new GraphQLNonNull(GraphQLConnectedAccountCreateInput),
        description: 'Connected Account data',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the external account will be connected',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ConnectedAccountModel> {
      checkRemoteUserCanUseConnectedAccounts(req);

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      await twoFactorAuthLib.enforceForAccount(req, collective);

      // Check feature access for TRANSFERWISE
      if (args.connectedAccount.service === Service.TRANSFERWISE) {
        await checkFeatureAccess(collective, FEATURE.TRANSFERWISE, { loaders: req.loaders });
      }
      // Check feature access for PAYPAL_PAYOUTS
      if (args.connectedAccount.service === Service.PAYPAL) {
        const payoutsAccess = await getFeatureAccess(collective, FEATURE.PAYPAL_PAYOUTS, { loaders: req.loaders });
        const paymentsAccess = await getFeatureAccess(collective, FEATURE.PAYPAL_DONATIONS, { loaders: req.loaders });
        if (payoutsAccess.access !== 'AVAILABLE' && paymentsAccess.access !== 'AVAILABLE') {
          throw new Forbidden(getErrorMessageFromFeatureAccess(payoutsAccess.access, payoutsAccess.reason));
        }
      }

      if ([Service.TRANSFERWISE, Service.PAYPAL].includes(args.connectedAccount.service)) {
        if (!args.connectedAccount.token) {
          throw new ValidationFailed('A token is required');
        }
        const sameTokenCount = await models.ConnectedAccount.count({
          where: { hash: crypto.hash(args.connectedAccount.service + args.connectedAccount.token) },
        });
        if (sameTokenCount > 0) {
          throw new ValidationFailed('This token is already being used');
        }

        if (args.connectedAccount.service === Service.TRANSFERWISE) {
          try {
            await transferwise.getProfiles(args.connectedAccount.token);
          } catch {
            throw new ValidationFailed('The token is not a valid TransferWise token');
          }
        } else if (args.connectedAccount.service === Service.PAYPAL) {
          try {
            await paypal.validateConnectedAccount(args.connectedAccount);
          } catch {
            throw new ValidationFailed('The Client ID and Token are not a valid combination');
          }
        }
      }

      if (args.connectedAccount.service === Service.PERSONA) {
        return personaKycProvider.provisionProvider({
          CollectiveId: collective.id,
          CreatedByUserId: req.remoteUser.id,
          apiKey: args.connectedAccount.data.apiKey,
          apiKeyId: args.connectedAccount.data.apiKeyId,
          inquiryTemplateId: args.connectedAccount.data.inquiryTemplateId,
        });
      }

      const connectedAccount = await models.ConnectedAccount.create({
        ...pick(args.connectedAccount, [
          'clientId',
          'data',
          'refreshToken',
          'settings',
          'token',
          'service',
          'username',
        ]),
        CollectiveId: collective.id,
        CreatedByUserId: req.remoteUser.id,
        hash: crypto.hash(args.connectedAccount.service + args.connectedAccount.token),
      });

      if (args.connectedAccount.service === Service.PAYPAL) {
        await paypal.setupPaypalWebhookForHost(collective);
      }

      return connectedAccount;
    },
  },
  deleteConnectedAccount: {
    type: GraphQLConnectedAccount,
    description: 'Delete ConnectedAccount. Scope: "connectedAccounts".',
    args: {
      connectedAccount: {
        type: new GraphQLNonNull(GraphQLConnectedAccountReferenceInput),
        description: 'ConnectedAccount reference containing either id or legacyId',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ConnectedAccountModel> {
      checkRemoteUserCanUseConnectedAccounts(req);

      const connectedAccount = await fetchConnectedAccountWithReference(args.connectedAccount, {
        throwIfMissing: true,
      });

      const collective = await req.loaders.Collective.byId.load(connectedAccount.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      }

      await twoFactorAuthLib.enforceForAccount(req, collective, { alwaysAskForToken: true });

      if (connectedAccount.service === Service.PLAID) {
        await disconnectPlaidAccount(connectedAccount);
      } else if (connectedAccount.service === Service.GOCARDLESS) {
        await disconnectGoCardlessAccount(connectedAccount);
      } else if (([Service.STRIPE, Service.PAYPAL] as string[]).includes(connectedAccount.service)) {
        const nbActiveOrders = await models.Order.countActiveRecurringForPaymentService(
          connectedAccount.service as Service.STRIPE | Service.PAYPAL,
        );

        if (nbActiveOrders > 0) {
          throw new ValidationFailed(
            'There are active contributions based on this payment provider. Please contact support to disconnect it.',
          );
        }
      }

      await connectedAccount.destroy();
      await models.ConnectedAccount.destroy({ where: { data: { MirrorConnectedAccountId: connectedAccount.id } } });

      return connectedAccount;
    },
  },
};

export default connectedAccountMutations;
