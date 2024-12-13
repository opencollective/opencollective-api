import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import { Service } from '../../../constants/connected-account';
import { crypto } from '../../../lib/encryption';
import * as paypal from '../../../lib/paypal';
import { disconnectPlaidAccount } from '../../../lib/plaid/connect';
import * as transferwise from '../../../lib/transferwise';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import type { ConnectedAccount as ConnectedAccountModel } from '../../../models';
import models from '../../../models';
import { checkRemoteUserCanUseConnectedAccounts } from '../../common/scope-check';
import { Unauthorized, ValidationFailed } from '../../errors';
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
      }

      await connectedAccount.destroy({ force: true });
      await models.ConnectedAccount.destroy({ where: { data: { MirrorConnectedAccountId: connectedAccount.id } } });

      return connectedAccount;
    },
  },
};

export default connectedAccountMutations;
