import express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { keyBy, mapValues, pick, uniqBy } from 'lodash';

import { purgeAllCachesForAccount, purgeGQLCacheForCollective } from '../../../lib/cache';
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
import models, { Op, sequelize } from '../../../models';
import { MigrationLogType } from '../../../models/MigrationLog';
import { checkRemoteUserCanRoot } from '../../common/scope-check';
import { Forbidden, ValidationFailed } from '../../errors';
import { AccountTypeToModelMapping } from '../enum';
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
      checkRemoteUserCanRoot(req);

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

      const baseAccounts = await fetchAccountsWithReferences(args.account);
      const allAccounts = !args.includeAssociatedAccounts ? baseAccounts : await getAccountsNetwork(baseAccounts);
      const accounts = uniqBy(allAccounts, 'id');
      if (accounts.some(a => a['data']?.['isTrustedHost'])) {
        throw new Forbidden('Cannot ban trusted hosts');
      } else if (!accounts.length) {
        return { isAllowed: false, accounts, message: 'No accounts to ban' };
      }

      const banSummary = await getBanSummary(accounts);
      const isAllowed = !banSummary.undeletableTransactionsCount;
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

      if (!args.expenses.length) {
        return [];
      } else if (!args.destinationAccount) {
        throw new ValidationFailed('You must specify a "destinationAccount" for the update');
      }

      const destinationAccount = await fetchAccountWithReference(args.destinationAccount, { throwIfMissing: true });

      if (destinationAccount.type === AccountTypeToModelMapping.INDIVIDUAL) {
        throw new ValidationFailed('The "destinationAccount" must not be an USER account');
      }

      const expenses = await fetchExpensesWithReferences(args.expenses);
      const expenseIds = expenses.map(expense => expense.id);

      // -- Move expenses --
      const result = await sequelize.transaction(async dbTransaction => {
        const associatedTransactionsCount = await models.Transaction.count({
          where: { ExpenseId: expenseIds },
          transaction: dbTransaction,
        });

        if (associatedTransactionsCount > 0) {
          throw new ValidationFailed('Cannot move expenses with associated transactions');
        }

        const [, updatedExpenses] = await models.Expense.update(
          { CollectiveId: destinationAccount.id },
          {
            transaction: dbTransaction,
            returning: true,
            where: { id: expenseIds },
          },
        );

        await models.MigrationLog.create(
          {
            type: MigrationLogType.MOVE_EXPENSES,
            description: `Moved ${expenses.length} expenses`,
            CreatedByUserId: req.remoteUser.id,
            data: {
              expenses: updatedExpenses.map(o => o.id),
              destinationAccount: destinationAccount.id,
              previousExpenseValues: mapValues(keyBy(expenses, 'id'), expense => pick(expense, ['CollectiveId'])),
            },
          },
          { transaction: dbTransaction },
        );

        return updatedExpenses;
      });

      return result;
    },
  },
};
