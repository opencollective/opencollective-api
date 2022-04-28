import express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull } from 'graphql';

import { purgeAllCachesForAccount, purgeGQLCacheForCollective } from '../../../lib/cache';
import { purgeCacheForPage } from '../../../lib/cloudflare';
import { invalidateContributorsCache } from '../../../lib/contributors';
import { mergeAccounts, simulateMergeAccounts } from '../../../lib/merge-accounts';
import { Forbidden } from '../../errors';
import { AccountCacheType } from '../enum/AccountCacheType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { Account } from '../interface/Account';
import { MergeAccountsResponse } from '../object/MergeAccountsResponse';

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
