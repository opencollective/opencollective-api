import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import { Service } from '../../../constants/connected_account';
import * as transferwise from '../../../lib/transferwise';
import models from '../../../models';
import * as errors from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ConnectedAccountCreateInput } from '../input/ConnectedAccountCreateInput';
import {
  ConnectedAccountReferenceInput,
  fetchConnectedAccountWithReference,
} from '../input/ConnectedAccountReferenceInput';
import { ConnectedAccount } from '../object/ConnectedAccount';

const connectedAccountMutations = {
  createConnectedAccount: {
    type: ConnectedAccount,
    description: 'Connect external account to Open Collective Account',
    args: {
      connectedAccount: {
        type: new GraphQLNonNull(ConnectedAccountCreateInput),
        description: 'Connected Account data',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the external account will be connected',
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new errors.Unauthorized({ message: 'You need to be logged in to create a connected account' });
      }

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdmin(collective.id)) {
        throw new errors.Unauthorized({ message: "You don't have permission to edit this collective" });
      }

      if (args.connectedAccount.service === Service.TRANSFERWISE) {
        if (!args.connectedAccount.token) {
          throw new errors.ValidationFailed({ message: 'A token is required for TransferWise accounts' });
        }
        const sameTokenCount = await models.ConnectedAccount.count({
          where: { service: Service.TRANSFERWISE, token: args.connectedAccount.token },
        });
        if (sameTokenCount > 0) {
          throw new errors.ValidationFailed({ message: 'This token is already being used' });
        }
        try {
          await transferwise.getProfiles(args.connectedAccount.token);
        } catch (e) {
          throw new errors.ValidationFailed({ message: 'The token is not a valid TransferWise token' });
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
      });

      return connectedAccount;
    },
  },
  deleteConnectedAccount: {
    type: ConnectedAccount,
    description: 'Delete ConnectedAccount',
    args: {
      connectedAccount: {
        type: new GraphQLNonNull(ConnectedAccountReferenceInput),
        description: 'ConnectedAccount reference containing either id or legacyId',
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new errors.Unauthorized({ message: 'You need to be logged in to delete a connected account' });
      }

      const connectedAccount = await fetchConnectedAccountWithReference(args.connectedAccount, {
        throwIfMissing: true,
      });
      if (!req.remoteUser.isAdmin(connectedAccount.CollectiveId)) {
        throw new errors.Unauthorized({ message: "You don't have permission to edit this collective" });
      }

      await connectedAccount.destroy({ force: true });
      return connectedAccount;
    },
  },
};

export default connectedAccountMutations;
