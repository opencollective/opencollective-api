import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash-es';

import { Service } from '../../../constants/connected_account.js';
import { crypto } from '../../../lib/encryption.js';
import * as paypal from '../../../lib/paypal.js';
import * as transferwise from '../../../lib/transferwise.js';
import twoFactorAuthLib from '../../../lib/two-factor-authentication/index.js';
import models from '../../../models/index.js';
import { ConnectedAccount as ConnectedAccountModel } from '../../../models/ConnectedAccount.js';
import { checkRemoteUserCanUseConnectedAccounts } from '../../common/scope-check.js';
import { Unauthorized, ValidationFailed } from '../../errors.js';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import { GraphQLConnectedAccountCreateInput } from '../input/ConnectedAccountCreateInput.js';
import { fetchConnectedAccountWithReference, GraphQLConnectedAccountReferenceInput } from '../input/ConnectedAccountReferenceInput.js';
import { GraphQLConnectedAccount } from '../object/ConnectedAccount.js';

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
          } catch (e) {
            throw new ValidationFailed('The token is not a valid TransferWise token');
          }
        } else if (args.connectedAccount.service === Service.PAYPAL) {
          try {
            await paypal.validateConnectedAccount(args.connectedAccount);
          } catch (e) {
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
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseConnectedAccounts(req);

      const connectedAccount = await fetchConnectedAccountWithReference(args.connectedAccount, {
        throwIfMissing: true,
      });

      const collective = await req.loaders.Collective.byId.load(connectedAccount.CollectiveId);
      if (!req.remoteUser.isAdminOfCollective(collective)) {
        throw new Unauthorized("You don't have permission to edit this collective");
      } else if (
        connectedAccount.service === 'transferwise' &&
        collective.settings?.transferwise?.isolateUsers &&
        req.remoteUser.id !== connectedAccount.CreatedByUserId
      ) {
        throw new Unauthorized("You don't have permission to edit this connected account");
      }

      await twoFactorAuthLib.enforceForAccount(req, collective, { alwaysAskForToken: true });

      await connectedAccount.destroy({ force: true });

      return connectedAccount;
    },
  },
};

export default connectedAccountMutations;
