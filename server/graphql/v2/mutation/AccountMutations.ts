import cryptoRandomString from 'crypto-random-string';
import express from 'express';
import { GraphQLBoolean, GraphQLFloat, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-type-json';
import { cloneDeep, set } from 'lodash';

import plans from '../../../constants/plans';
import cache, { purgeAllCachesForAccount, purgeGQLCacheForCollective } from '../../../lib/cache';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import { invalidateContributorsCache } from '../../../lib/contributors';
import { crypto } from '../../../lib/encryption';
import { mergeAccounts, simulateMergeAccounts } from '../../../lib/merge-accounts';
import { verifyTwoFactorAuthenticatorCode } from '../../../lib/two-factor-authentication';
import models, { sequelize } from '../../../models';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { AccountCacheType } from '../enum/AccountCacheType';
import { AccountTypeToModelMapping } from '../enum/AccountType';
import { idDecode } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AccountUpdateInput } from '../input/AccountUpdateInput';
import { Account } from '../interface/Account';
import { Host } from '../object/Host';
import { Individual } from '../object/Individual';
import { MergeAccountsResponse } from '../object/MergeAccountsResponse';
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
      isCustomFee: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'If using a custom fee, set this to true',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
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

        const updateAccountFees = account => {
          return account.update(
            {
              hostFeePercent: args.hostFeePercent,
              data: { ...account.data, useCustomHostFee: args.isCustomFee },
            },
            { transaction: dbTransaction },
          );
        };

        // Update main account
        await updateAccountFees(account);

        // Cascade host update to events and projects
        // Passing platformFeePercent through options so we don't request the parent collective on every children update
        const children = await account.getChildren({ transaction: dbTransaction });
        if (children.length > 0) {
          await Promise.all(children.map(updateAccountFees));
        }

        return account;
      });
    },
  },
  addTwoFactorAuthTokenToIndividual: {
    type: new GraphQLNonNull(AddTwoFactorAuthTokenToIndividualResponse),
    description: 'Add 2FA to the Individual if it does not have it',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Individual that will have 2FA added to it',
      },
      token: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The generated secret to save to the Individual',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
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

      /** Generate recovery codes, hash and store them in the table, and return them to the user to write down */
      const recoveryCodesArray = Array.from({ length: 6 }, () =>
        cryptoRandomString({ length: 16, type: 'distinguishable' }),
      );
      const hashedRecoveryCodesArray = recoveryCodesArray.map(code => {
        return crypto.hash(code);
      });

      await user.update({ twoFactorAuthToken: encryptedText, twoFactorAuthRecoveryCodes: hashedRecoveryCodesArray });

      return { account: account, recoveryCodes: recoveryCodesArray };
    },
  },
  removeTwoFactorAuthTokenFromIndividual: {
    type: new GraphQLNonNull(Individual),
    description: 'Remove 2FA from the Individual if it has been enabled',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account that will have 2FA removed from it',
      },
      code: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The 6-digit 2FA code',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
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

      if (!user.twoFactorAuthToken) {
        throw new Unauthorized('This account already has 2FA disabled.');
      }

      const verified = verifyTwoFactorAuthenticatorCode(user.twoFactorAuthToken, args.code);

      if (!verified) {
        throw new Unauthorized('Two-factor authentication code failed. Please try again');
      }

      await user.update({ twoFactorAuthToken: null, twoFactorAuthRecoveryCodes: null });

      return account;
    },
  },
  editHostPlan: {
    type: new GraphQLNonNull(Host),
    description: 'Update the plan',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the host plan will be edited.',
      },
      plan: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The name of the plan to subscribe to.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const account = await fetchAccountWithReference(args.account);
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Forbidden();
      }
      if (!account.isHostAccount) {
        throw new Error(`Only Fiscal Hosts can set their plan.`);
      }

      const plan = args.plan;
      if (!plans[plan]) {
        throw new Error(`Unknown plan: ${plan}`);
      }

      await account.update({ plan });

      if (plan === 'start-plan-2021') {
        // This should cascade to all Collectives
        await account.updateHostFee(0, req.remoteUser);
      }

      if (plan === 'start-plan-2021' || plan === 'grow-plan-2021') {
        // This should cascade to all Collectives
        await account.updatePlatformFee(0, req.remoteUser);

        // Make sure budget is activated
        await account.activateBudget();
      }

      await cache.del(`plan_${account.id}`);

      return account;
    },
  },
  editAccount: {
    type: new GraphQLNonNull(Host),
    description: 'Edit key properties of an account.',
    args: {
      account: {
        type: new GraphQLNonNull(AccountUpdateInput),
        description: 'Account to edit.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const id = idDecode(args.account.id, 'account');
      const account = await req.loaders.Collective.byId.load(id);
      if (!account) {
        throw new NotFound('Account Not Found');
      }

      if (!req.remoteUser.isAdminOfCollective(account) && !req.remoteUser.isRoot()) {
        throw new Forbidden();
      }

      for (const key of Object.keys(args.account)) {
        switch (key) {
          case 'currency':
            await account.setCurrency(args.account[key]);
        }
      }

      return account;
    },
  },
  clearCacheForAccount: {
    type: new GraphQLNonNull(Account),
    description: '[Root only] Clears the cache for a given account',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account to clear the cache for',
      },
      type: {
        type: new GraphQLNonNull(new GraphQLList(AccountCacheType)),
        description: 'Types of cache to clear',
        defaultValue: ['CLOUDFLARE', 'GRAPHQL_QUERIES', 'CONTRIBUTORS'],
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser?.isRoot()) {
        throw new Forbidden('Only root users can perform this action');
      }

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });

      if (args.type.includes('CLOUDFLARE')) {
        purgeCacheForPage(`/${account.slug}`);
      }
      if (args.type.includes('GRAPHQL_QUERIES')) {
        purgeGQLCacheForCollective(account.slug);
      }
      if (args.type.includes('CONTRIBUTORS')) {
        await invalidateContributorsCache(account.id);
      }

      return account;
    },
  },
  mergeAccounts: {
    type: new GraphQLNonNull(MergeAccountsResponse),
    description: '[Root only] Merge two accounts, returns the result account',
    args: {
      fromAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account to merge from',
      },
      toAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account to merge to',
      },
      dryRun: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'If true, the result will be simulated and summarized in the response message',
        defaultValue: true,
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      if (!req.remoteUser?.isRoot()) {
        throw new Forbidden('Only root users can perform this action');
      }

      const fromAccount = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
      const toAccount = await fetchAccountWithReference(args.toAccount, { throwIfMissing: true });

      if (args.dryRun) {
        const message = await simulateMergeAccounts(fromAccount, toAccount);
        return { account: toAccount, message };
      } else {
        const warnings = await mergeAccounts(fromAccount, toAccount, req.remoteUser.id);
        await Promise.all([purgeAllCachesForAccount(fromAccount), purgeAllCachesForAccount(toAccount)]).catch(() => {
          // Ignore errors
        });
        const message = warnings.join('\n');
        return { account: await toAccount.reload(), message: message || null };
      }
    },
  },
};

export default accountMutations;
