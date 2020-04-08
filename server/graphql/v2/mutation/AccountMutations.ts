import { GraphQLNonNull } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { set, cloneDeep } from 'lodash';

import { sequelize } from '../../../models';
import { Unauthorized, Forbidden, NotFound } from '../../errors';
import { types as collectiveTypes } from '../../../constants/collectives';

import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Account } from '../interface/Account';
import AccountSettingsKey from '../scalar/AccountSettingsKey';

const { COLLECTIVE } = collectiveTypes;

const accountMutations = {
  editAccountSetting: {
    type: new GraphQLNonNull(Account),
    description: 'Edit the settings for the given account',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the settings will be updated',
      },
      key: {
        type: new GraphQLNonNull(AccountSettingsKey),
        description: 'The key that you want to edit in settings',
      },
      value: {
        type: new GraphQLNonNull(GraphQLJSON),
        description: 'The value to set for this key',
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      return sequelize.transaction(async transaction => {
        const account = await fetchAccountWithReference(args.account, {
          dbTransaction: transaction,
          lock: true,
          throwIfMissing: true,
        });

        if (!req.remoteUser.isAdmin(account.id)) {
          throw new Forbidden();
        }

        const settings = account.settings ? cloneDeep(account.settings) : {};
        set(settings, args.key, args.value);
        return account.update({ settings }, { transaction });
      });
    },
  },

  applyToHost: {
    type: new GraphQLNonNull(Account),
    description: 'Apply to an host with a collective',
    args: {
      collective: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account applying to the host.',
      },
      host: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Host to apply to.',
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const collective = await fetchAccountWithReference(args.collective);
      if (!collective) {
        throw new NotFound({ message: 'Collective not found' });
      }
      if (collective.type !== COLLECTIVE) {
        throw new Error('Account not a Collective');
      }

      const host = await fetchAccountWithReference(args.host);
      if (!host) {
        throw new NotFound({ message: 'Host not found' });
      }
      const isHost = await host.isHost();
      if (!isHost) {
        throw new Error('Account is not an host');
      }
      const canApply = await host.canApply();
      if (!canApply) {
        throw new Error('Host is not open to applications');
      }

      // No need to check the balance, this is being handled in changeHost

      return collective.changeHost(host.id, req.remoteUser);
    },
  },
};

export default accountMutations;
