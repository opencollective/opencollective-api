import { GraphQLFloat, GraphQLNonNull, GraphQLString } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { cloneDeep, set } from 'lodash';

import { crypto } from '../../../lib/encryption';
import models, { sequelize } from '../../../models';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { AccountTypeToModelMapping } from '../enum/AccountType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Account } from '../interface/Account';
import { Individual } from '../object/Individual';
import AccountSettingsKey from '../scalar/AccountSettingsKey';

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

        if (!req.remoteUser.isAdminOfCollective(account)) {
          throw new Forbidden();
        }

        if (
          args.key === 'collectivePage' &&
          ![AccountTypeToModelMapping.FUND, AccountTypeToModelMapping.PROJECT].includes(account.type)
        ) {
          const budgetSection = args.value.sections?.find(s => s.section === 'budget');
          if (budgetSection && !budgetSection.isEnabled) {
            throw new Forbidden();
          }
        }

        const settings = account.settings ? cloneDeep(account.settings) : {};
        set(settings, args.key, args.value);
        return account.update({ settings }, { transaction });
      });
    },
  },
  editAccountFeeStructure: {
    type: new GraphQLNonNull(Account),
    description: 'An endpoint for hosts to edit the fees structure of their hosted accounts',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the settings will be updated',
      },
      hostFeePercent: {
        type: new GraphQLNonNull(GraphQLFloat),
        description: 'The host fee percent to apply to this account',
      },
    },
    async resolve(_, args, req): Promise<object> {
      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });

      if (!account.HostCollectiveId) {
        throw new ValidationFailed('Fees structure can only be edited for accounts that you are hosting');
      } else if (!req.remoteUser?.isAdmin(account.HostCollectiveId)) {
        throw new Forbidden(
          'You need to be logged in as an host admin to change the fees structure of the hosted accounts',
        );
      } else if (!account.approvedAt) {
        throw new ValidationFailed('The collective needs to be approved before you can change the fees structure');
      }

      return account.update({ hostFeePercent: args.hostFeePercent });
    },
  },
  addTwoFactorAuthTokenToIndividual: {
    type: new GraphQLNonNull(Individual),
    description: 'Add 2FA to the Account if it does not have it',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account that will have 2FA added to it',
      },
      token: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The generated secret to save to the Account',
      },
    },
    async resolve(_, args, req): Promise<object> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const account = await fetchAccountWithReference(args.account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }

      const user = await models.User.findOne({ where: { CollectiveId: account.id } });

      if (!user) {
        throw new NotFound('Account not found.');
      }

      if (user.twoFactorAuthToken !== null) {
        throw new Unauthorized('This account already has 2FA enabled.');
      }

      /* 
      check that base32 secret is only capital letters, numbers (2-7), 103 chars long;
      Our secret is 64 ascii characters which is encoded into 104 base32 characters
      (base32 should be divisible by 8). But the last character is an = to pad, and
      speakeasy library cuts out any = padding
      **/
      const verifyToken = args.token.match(/([A-Z2-7]){103}/);
      if (!verifyToken) {
        throw new ValidationFailed('Invalid 2FA token');
      }

      const encryptedText = crypto.encrypt(args.token);

      await user.update({ twoFactorAuthToken: encryptedText });

      return account;
    },
  },
};

export default accountMutations;
