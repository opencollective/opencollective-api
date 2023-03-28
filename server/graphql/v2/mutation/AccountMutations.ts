import cryptoRandomString from 'crypto-random-string';
import express from 'express';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';
import { cloneDeep, isNull, omitBy, set } from 'lodash';

import activities from '../../../constants/activities';
import { types as COLLECTIVE_TYPE } from '../../../constants/collectives';
import * as collectivelib from '../../../lib/collectivelib';
import { crypto } from '../../../lib/encryption';
import TwoFactorAuthLib, { TwoFactorMethod } from '../../../lib/two-factor-authentication';
import { validateYubikeyOTP } from '../../../lib/two-factor-authentication/yubikey-otp';
import models, { sequelize } from '../../../models';
import { sendMessage } from '../../common/collective';
import { checkRemoteUserCanUseAccount, checkRemoteUserCanUseHost } from '../../common/scope-check';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { AccountTypeToModelMapping } from '../enum/AccountType';
import { TwoFactorMethodEnum } from '../enum/TwoFactorMethodEnum';
import { idDecode } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AccountUpdateInput } from '../input/AccountUpdateInput';
import { PoliciesInput } from '../input/PoliciesInput';
import { Account } from '../interface/Account';
import { Host } from '../object/Host';
import { Individual } from '../object/Individual';
import AccountSettingsKey from '../scalar/AccountSettingsKey';

const AddTwoFactorAuthTokenToIndividualResponse = new GraphQLObjectType({
  name: 'AddTwoFactorAuthTokenToIndividualResponse',
  description: 'Response for the addTwoFactorAuthTokenToIndividual mutation',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(Individual),
      description: 'The Individual that the 2FA has been enabled for',
    },
    recoveryCodes: {
      type: new GraphQLList(GraphQLString),
      description: 'The recovery codes for the Individual to write down',
    },
  }),
});

const accountMutations = {
  editAccountSetting: {
    type: new GraphQLNonNull(Account),
    description: 'Edit the settings for the given account. Scope: "account" or "host".',
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
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      return sequelize.transaction(async transaction => {
        const account = await fetchAccountWithReference(args.account, {
          dbTransaction: transaction,
          lock: true,
          throwIfMissing: true,
        });

        const isKeyEditableByHostAdmins = ['expenseTypes'].includes(args.key);
        const permissionMethod = isKeyEditableByHostAdmins ? 'isAdminOfCollectiveOrHost' : 'isAdminOfCollective';
        if (!req.remoteUser[permissionMethod](account)) {
          throw new Forbidden();
        }

        // If the user is not admin and was not Forbidden, it means it's the Host and we check "host" scope
        if (!req.remoteUser.isAdminOfCollective(account)) {
          checkRemoteUserCanUseHost(req);
        } else {
          checkRemoteUserCanUseAccount(req);
        }

        // Enforce 2FA if trying to change 2FA rolling limit settings while it's already enabled
        if (args.key.split('.')[0] === 'payoutsTwoFactorAuth' && account.settings?.payoutsTwoFactorAuth?.enabled) {
          await TwoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true, requireTwoFactorAuthEnabled: true });
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

        const previousData = { settings: { [args.key]: account.data?.[args.key] } };
        const updatedAccount = await account.update({ settings }, { transaction });
        await models.Activity.create(
          {
            type: activities.COLLECTIVE_EDITED,
            UserId: req.remoteUser.id,
            UserTokenId: req.userToken?.id,
            CollectiveId: account.id,
            FromCollectiveId: account.id,
            HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
            data: {
              previousData,
              newData: { settings: { [args.key]: args.value } },
            },
          },
          { transaction },
        );

        return updatedAccount;
      });
    },
  },
  editAccountFeeStructure: {
    type: new GraphQLNonNull(Account),
    description: 'An endpoint for hosts to edit the fees structure of their hosted accounts. Scope: "host".',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the settings will be updated',
      },
      hostFeePercent: {
        type: new GraphQLNonNull(GraphQLFloat),
        description: 'The host fee percent to apply to this account',
      },
      isCustomFee: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'If using a custom fee, set this to true',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseHost(req);

      return sequelize.transaction(async dbTransaction => {
        const account = await fetchAccountWithReference(args.account, {
          throwIfMissing: true,
          dbTransaction,
          lock: true,
        });

        if (!account.HostCollectiveId) {
          throw new ValidationFailed('Fees structure can only be edited for accounts that you are hosting');
        } else if (!req.remoteUser?.isAdmin(account.HostCollectiveId)) {
          throw new Forbidden(
            'You need to be logged in as an host admin to change the fees structure of the hosted accounts',
          );
        } else if (!account.approvedAt) {
          throw new ValidationFailed('The collective needs to be approved before you can change the fees structure');
        }

        const updateAccountFees = async account => {
          return account.update(
            {
              hostFeePercent: args.hostFeePercent,
              data: { ...account.data, useCustomHostFee: args.isCustomFee },
            },
            { transaction: dbTransaction },
          );
        };

        const previousData = {
          hostFeePercent: account.hostFeePercent,
          useCustomHostFee: account.data?.useCustomHostFee,
        };

        // Update main account
        await updateAccountFees(account);

        // Cascade host update to events and projects
        // Passing platformFeePercent through options so we don't request the parent collective on every children update
        const children = await account.getChildren({ transaction: dbTransaction });
        if (children.length > 0) {
          await Promise.all(children.map(updateAccountFees));
        }

        await models.Activity.create(
          {
            type: activities.COLLECTIVE_EDITED,
            UserId: req.remoteUser.id,
            UserTokenId: req.userToken?.id,
            CollectiveId: account.id,
            FromCollectiveId: account.id,
            HostCollectiveId: account.HostCollectiveId,
            data: {
              previousData,
              newData: { hostFeePercent: args.hostFeePercent, useCustomHostFee: args.isCustomFee },
            },
          },
          { transaction: dbTransaction },
        );

        return account;
      });
    },
  },
  editAccountFreezeStatus: {
    type: new GraphQLNonNull(Account),
    description: 'An endpoint for hosts to edit the freeze status of their hosted accounts. Scope: "host".',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account to freeze',
      },
      action: {
        type: new GraphQLNonNull(
          new GraphQLEnumType({ name: 'AccountFreezeAction', values: { FREEZE: {}, UNFREEZE: {} } }),
        ),
      },
      message: {
        type: GraphQLString,
        description: 'Message to send by email to the admins of the account',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<void> {
      checkRemoteUserCanUseHost(req);

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      account.host = await account.getHostCollective();
      if (!account.host) {
        throw new ValidationFailed('Cannot find the host of this account');
      } else if (!req.remoteUser.isAdminOfCollective(account.host)) {
        throw new Unauthorized();
      } else if (![COLLECTIVE_TYPE.COLLECTIVE, COLLECTIVE_TYPE.FUND].includes(account.type)) {
        throw new ValidationFailed(
          'Only collective and funds can be frozen. To freeze children accounts (projects, events) you need to freeze the parent account.',
        );
      }

      if (args.action === 'FREEZE') {
        await account.freeze(args.message);
      } else if (args.action === 'UNFREEZE') {
        await account.unfreeze(args.message);
      }

      return account.reload();
    },
  },
  addTwoFactorAuthTokenToIndividual: {
    type: new GraphQLNonNull(AddTwoFactorAuthTokenToIndividualResponse),
    description: 'Add 2FA to the Individual if it does not have it. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Individual that will have 2FA added to it',
      },
      type: {
        type: TwoFactorMethodEnum,
      },
      token: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The generated secret to save to the Individual',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }

      const user = await models.User.findOne({ where: { CollectiveId: account.id } });

      if (!user) {
        throw new NotFound('Account not found.');
      }

      const type = (args.type as TwoFactorMethod) || TwoFactorMethod.TOTP;
      const userEnabledMethods = TwoFactorAuthLib.twoFactorMethodsSupportedByUser(user);

      if (userEnabledMethods.includes(type)) {
        throw new Unauthorized('This account already has this 2FA method enabled.');
      }

      switch (type) {
        case TwoFactorMethod.TOTP: {
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
          break;
        }
        case TwoFactorMethod.YUBIKEY_OTP: {
          const validYubikeyOTP = await validateYubikeyOTP(args.token);

          if (!validYubikeyOTP) {
            throw new ValidationFailed('Invalid 2FA token');
          }

          await user.update({ yubikeyDeviceId: (args.token as string).substring(0, 12) });

          break;
        }
        default: {
          throw new ValidationFailed('Unsupported 2FA method');
        }
      }

      let recoveryCodesArray;
      if (userEnabledMethods.length === 0) {
        /** Generate recovery codes, hash and store them in the table, and return them to the user to write down */
        recoveryCodesArray = Array.from({ length: 6 }, () =>
          cryptoRandomString({ length: 16, type: 'distinguishable' }),
        );
        const hashedRecoveryCodesArray = recoveryCodesArray.map(code => {
          return crypto.hash(code);
        });
        await user.update({ twoFactorAuthRecoveryCodes: hashedRecoveryCodesArray });
      }

      await models.Activity.create({
        type: activities.TWO_FACTOR_CODE_ADDED,
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: user.CollectiveId,
      });

      return { account: account, recoveryCodes: recoveryCodesArray };
    },
  },
  removeTwoFactorAuthTokenFromIndividual: {
    type: new GraphQLNonNull(Individual),
    description: 'Remove 2FA from the Individual if it has been enabled. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account that will have 2FA removed from it',
      },
      type: {
        type: TwoFactorMethodEnum,
      },
      code: {
        type: GraphQLString,
        description: 'The 6-digit 2FA code',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseAccount(req);

      const account = await fetchAccountWithReference(args.account);

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }

      const user = await models.User.findOne({ where: { CollectiveId: account.id } });

      if (!user) {
        throw new NotFound('Account not found.');
      }

      if (TwoFactorAuthLib.twoFactorMethodsSupportedByUser(user).length === 0) {
        throw new Unauthorized('This account already has 2FA disabled.');
      }

      await TwoFactorAuthLib.validateRequest(req, {
        requireTwoFactorAuthEnabled: true,
        alwaysAskForToken: true,
      });

      switch (args.type as TwoFactorMethod) {
        case TwoFactorMethod.TOTP: {
          await user.update({ twoFactorAuthToken: null });
          break;
        }
        case TwoFactorMethod.YUBIKEY_OTP: {
          await user.update({ yubikeyDeviceId: null });
          break;
        }
        default: {
          await user.update({ twoFactorAuthToken: null, yubikeyDeviceId: null });
        }
      }

      if (TwoFactorAuthLib.twoFactorMethodsSupportedByUser(user).length === 0) {
        await user.update({ twoFactorAuthRecoveryCodes: null });
      }

      await models.Activity.create({
        type: activities.TWO_FACTOR_CODE_DELETED,
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: user.CollectiveId,
        UserTokenId: req.userToken?.id,
      });

      return account;
    },
  },
  editAccount: {
    type: new GraphQLNonNull(Host),
    description: 'Edit key properties of an account. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(AccountUpdateInput),
        description: 'Account to edit.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanUseAccount(req);

      const id = idDecode(args.account.id, 'account');
      const account = await req.loaders.Collective.byId.load(id);
      if (!account) {
        throw new NotFound('Account Not Found');
      }

      if (!req.remoteUser.isAdminOfCollective(account) && !req.remoteUser.isRoot()) {
        throw new Forbidden();
      }

      await TwoFactorAuthLib.enforceForAccount(req, account, { onlyAskOnLogin: true });

      for (const key of Object.keys(args.account)) {
        switch (key) {
          case 'currency': {
            const previousData = { currency: account.currency };
            await account.setCurrency(args.account[key]);
            await models.Activity.create({
              type: activities.COLLECTIVE_EDITED,
              UserId: req.remoteUser.id,
              UserTokenId: req.userToken?.id,
              CollectiveId: account.id,
              FromCollectiveId: account.id,
              HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
              data: { previousData, newData: { currency: args.account[key] } },
            });
          }
        }
      }

      return account;
    },
  },
  setPolicies: {
    type: new GraphQLNonNull(Account),
    description: 'Adds or removes a policy on a given account. Scope: "account".',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the policies are being set',
      },
      policies: {
        type: new GraphQLNonNull(PoliciesInput),
        description: 'The policy to be added',
      },
    },

    async resolve(_: void, args, req: express.Request): Promise<void> {
      checkRemoteUserCanUseAccount(req);

      const id = args.account.legacyId || idDecode(args.account.id, 'account');
      const account = await req.loaders.Collective.byId.load(id);
      if (!account) {
        throw new NotFound('Account Not Found');
      }

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized();
      }

      // Merge submitted policies with existing ones
      const previousPolicies = account.data?.policies;
      const newPolicies = omitBy({ ...previousPolicies, ...args.policies }, isNull);

      // Enforce 2FA when trying to disable `REQUIRE_2FA_FOR_ADMINS`
      if (previousPolicies?.REQUIRE_2FA_FOR_ADMINS && !newPolicies.REQUIRE_2FA_FOR_ADMINS) {
        await TwoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true, requireTwoFactorAuthEnabled: true });
      }

      await account.setPolicies(newPolicies);
      await models.Activity.create({
        type: activities.COLLECTIVE_EDITED,
        UserId: req.remoteUser.id,
        UserTokenId: req.userToken?.id,
        CollectiveId: account.id,
        FromCollectiveId: account.id,
        HostCollectiveId: account.approvedAt ? account.HostCollectiveId : null,
        data: { previousData: { policies: previousPolicies }, newData: { policies: newPolicies } },
      });

      return account;
    },
  },
  deleteAccount: {
    type: Account,
    description: 'Adds or removes a policy on a given account. Scope: "account".',
    args: {
      account: {
        description: 'Reference to the Account to be deleted.',
        type: new GraphQLNonNull(AccountReferenceInput),
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanUseAccount(req);

      const id = args.account.legacyId || idDecode(args.account.id, 'account');
      const account = await req.loaders.Collective.byId.load(id);
      if (!account) {
        throw new NotFound('Account Not Found');
      }

      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('You need to be logged in as an Admin of the account.');
      }

      await TwoFactorAuthLib.enforceForAccount(req, account, { alwaysAskForToken: true });

      if (await account.isHost()) {
        throw new Error(
          `You can't delete an account activated as Host. Please, desactivate the account as Host and try again.`,
        );
      }

      if (!(await collectivelib.isCollectiveDeletable(account))) {
        throw new Error(
          `You can't delete an Account with admin memberships, children, transactions, orders or expenses. Please archive it instead.`,
        );
      }

      return collectivelib.deleteCollective(account);
    },
  },
  sendMessage: {
    type: new GraphQLObjectType({
      name: 'SendMessageResult',
      fields: {
        success: { type: GraphQLBoolean },
      },
    }),
    description: 'Send a message to an account. Scope: "account"',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Reference to the Account to send message to.',
      },
      message: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'Message to send to the account.',
      },
      subject: { type: GraphQLString },
    },
    async resolve(_, args, req) {
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });

      return sendMessage({ req, args, collective: account, isGqlV2: true });
    },
  },
};

export default accountMutations;
