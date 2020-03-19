import { pick } from 'lodash';
import { GraphQLNonNull } from 'graphql';

import { ConnectedAccount } from '../object/ConnectedAccount';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ConnectedAccountCreateInput } from '../input/ConnectedAccountCreateInput';
import models from '../../../models';
import * as errors from '../../errors';
import {
  ConnectedAccountReferenceInput,
  fetchConnectedAccountWithReference,
} from '../input/ConnectedAccountReferenceInput';

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
        throw new errors.Unauthorized('You need to be logged in to create a connected account');
      }

      const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdmin(collective.id)) {
        throw new errors.Unauthorized("You don't have permission to edit this collective");
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
        throw new errors.Unauthorized('You need to be logged in to delete a connected account');
      }

      const connectedAccount = await fetchConnectedAccountWithReference(args.connectedAccount, {
        throwIfMissing: true,
      });
      if (!req.remoteUser.isAdmin(connectedAccount.CollectiveId)) {
        throw new errors.Unauthorized("You don't have permission to edit this collective");
      }

      await connectedAccount.destroy({ force: true });
      return connectedAccount;
    },
  },
};

export default connectedAccountMutations;
