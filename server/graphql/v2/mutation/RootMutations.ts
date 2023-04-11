import express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { cloneDeep, isNil, omit, uniqBy } from 'lodash';

import { types as collectiveTypes } from '../../../constants/collectives';
import roles from '../../../constants/roles';
import { purgeAllCachesForAccount, purgeGraphqlCacheForCollective } from '../../../lib/cache';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import { invalidateContributorsCache } from '../../../lib/contributors';
import { mergeAccounts, simulateMergeAccounts } from '../../../lib/merge-accounts';
import {
  banAccounts,
  getAccountsNetwork,
  getBanSummary,
  stringifyBanResult,
  stringifyBanSummary,
} from '../../../lib/moderation';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { sequelize } from '../../../models';
import UserTwoFactorMethod from '../../../models/UserTwoFactorMethod';
import { moveExpenses } from '../../common/expenses';
import { checkRemoteUserCanRoot } from '../../common/scope-check';
import { Forbidden } from '../../errors';
import { archiveCollective, unarchiveCollective } from '../../v1/mutations/collectives';
import { AccountCacheType } from '../enum/AccountCacheType';
import {
  AccountReferenceInput,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
} from '../input/AccountReferenceInput';
import { ExpenseReferenceInput, fetchExpensesWithReferences } from '../input/ExpenseReferenceInput';
import { Account } from '../interface/Account';
import { Expense } from '../object/Expense';
import { MergeAccountsResponse } from '../object/MergeAccountsResponse';

const BanAccountResponse = new GraphQLObjectType({
  name: 'BanAccountResponse',
  fields: () => ({
    isAllowed: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the accounts can be banned',
    },
    message: {
      type: GraphQLString,
      description: 'A summary of the changes',
    },
    accounts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Account))),
      description: 'The accounts impacted by the mutation',
    },
  }),
});

/**
 * Root mutations
 */
export default {
  editAccountFlags: {
    type: new GraphQLNonNull(Account),
    description: '[Root only] Edits account flags (deleted, banned, archived, trusted host)',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account to change the flags for',
      },
      isArchived: {
        type: GraphQLBoolean,
        description: 'Specify whether the account is archived',
      },
      isTrustedHost: {
        type: GraphQLBoolean,
        description: 'Specify whether the account is a trusted host',
      },
      isTwoFactorAuthEnabled: {
        type: GraphQLBoolean,
        description: 'Set this to false to disable 2FA. Other values have no effect.',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true, paranoid: false });

      if (args.isArchived && !account.deactivatedAt) {
        await archiveCollective(_, account, req);
      } else if (args.isArchived === false && account.deactivatedAt) {
        await unarchiveCollective(_, account, req);
      }

      if (!isNil(args.isTrustedHost) && Boolean(args.isTrustedHost) !== Boolean(account.data?.isTrustedHost)) {
        await account.update({ data: { ...account.data, isTrustedHost: args.isTrustedHost } });
      }

      if (args.isTwoFactorAuthEnabled === false) {
        const user = await account.getUser();
        await UserTwoFactorMethod.destroy({
          where: {
            UserId: user.id,
          },
        });
      }
      return account;
    },
  },
  editAccountType: {
    type: new GraphQLNonNull(Account),
    description: '[Root only] Edits account type from User to Organization',
    args: {
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account to change the type for',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true, paranoid: false });

      if (account.isHostAccount) {
        throw new Error('Cannot change type of host account');
      } else if (account.type !== collectiveTypes.USER) {
        throw new Error('editAccountType only works on individual profiles');
      } else if (account.data.isGuest) {
        throw new Error('editAccountType does not work on guest profiles');
      }

      const collectiveData = omit(cloneDeep(account.dataValues), ['id']);
      collectiveData.slug = `${collectiveData.slug}-user`;
      collectiveData.createdAt = new Date();
      let collective;

      await sequelize.transaction(async transaction => {
        // Create new USER account in the Collectives table
        collective = await models.Collective.create(collectiveData, { transaction });

        // Update the corresponding CollectiveId in Users to this new profile
        const user = await models.User.findOne({ where: { CollectiveId: account.id }, transaction });
        await user.update({ CollectiveId: collective.id }, { transaction });

        // Change the type of the original USER account to Organization
        await account.update({ type: collectiveTypes.ORGANIZATION }, { transaction });
      });

      // Add admin user for the new Organization
      if (collective) {
        await models.Member.create({
          CreatedByUserId: req.remoteUser.id,
          CollectiveId: account.id,
          MemberCollectiveId: collective.id,
          role: roles.ADMIN,
        });
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
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const asyncActions = [];

      if (args.type.includes('CLOUDFLARE')) {
        asyncActions.push(purgeCacheForPage(`/${account.slug}`));
      }
      if (args.type.includes('GRAPHQL_QUERIES')) {
        asyncActions.push(purgeGraphqlCacheForCollective(account.slug));
      }
      if (args.type.includes('CONTRIBUTORS')) {
        asyncActions.push(invalidateContributorsCache(account.id));
      }

      await Promise.all(asyncActions);
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
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

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
  banAccount: {
    type: new GraphQLNonNull(BanAccountResponse),
    description: '[Root only] Ban accounts',
    args: {
      account: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(AccountReferenceInput))),
        description: 'Account(s) to ban',
      },
      includeAssociatedAccounts: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'If true, the associated accounts will also be banned',
      },
      dryRun: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'If true, the result will be simulated and summarized in the response message',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const baseAccounts = await fetchAccountsWithReferences(args.account);
      const allAccounts = !args.includeAssociatedAccounts ? baseAccounts : await getAccountsNetwork(baseAccounts);
      const accounts = uniqBy(allAccounts, 'id');
      if (accounts.some(a => a['data']?.['isTrustedHost'])) {
        throw new Forbidden('Cannot ban trusted hosts');
      } else if (!accounts.length) {
        return { isAllowed: false, accounts, message: 'No accounts to ban' };
      }

      const banSummary = await getBanSummary(accounts);
      const isAllowed = !(banSummary.undeletableTransactionsCount || banSummary.newOrdersCount);
      if (args.dryRun) {
        return { isAllowed, accounts, message: stringifyBanSummary(banSummary) };
      }

      if (!isAllowed) {
        throw new Error(stringifyBanSummary(banSummary));
      } else {
        const result = await banAccounts(accounts, req.remoteUser.id);
        return { isAllowed, accounts, message: stringifyBanResult(result) };
      }
    },
  },
  moveExpenses: {
    type: new GraphQLNonNull(new GraphQLList(Expense)),
    description: '[Root only] A mutation to move expenses from one account to another',
    args: {
      expenses: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ExpenseReferenceInput))),
        description: 'The orders to move',
      },
      destinationAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'The account to move the expenses to. This must be a non USER account.',
      },
    },
    async resolve(_, args, req) {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const destinationAccount = await fetchAccountWithReference(args.destinationAccount, { throwIfMissing: true });
      const expenses = await fetchExpensesWithReferences(args.expenses, {
        include: { association: 'collective', required: true },
        throwIfMissing: true,
      });

      return moveExpenses(req, expenses, destinationAccount);
    },
  },
};
