import express from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { cloneDeep, isNil, omit, pick, uniqBy } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import OrderStatuses from '../../../constants/order-status';
import roles from '../../../constants/roles';
import { TransactionKind } from '../../../constants/transaction-kind';
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
import models, { Collective, sequelize } from '../../../models';
import UserTwoFactorMethod from '../../../models/UserTwoFactorMethod';
import { moveExpenses } from '../../common/expenses';
import { checkRemoteUserCanRoot } from '../../common/scope-check';
import { Forbidden } from '../../errors';
import { archiveCollective, unarchiveCollective } from '../../v1/mutations/collectives';
import { GraphQLAccountCacheType } from '../enum/AccountCacheType';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import { fetchExpensesWithReferences, GraphQLExpenseReferenceInput } from '../input/ExpenseReferenceInput';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLExpense } from '../object/Expense';
import { GraphQLMergeAccountsResponse } from '../object/MergeAccountsResponse';
import { GraphQLOrder } from '../object/Order';

const GraphQLBanAccountResponse = new GraphQLObjectType({
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
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAccount))),
      description: 'The accounts impacted by the mutation',
    },
  }),
});

/**
 * Root mutations
 */
export default {
  editAccountFlags: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: '[Root only] Edits account flags (deleted, banned, archived, trusted host)',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
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
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
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
    type: new GraphQLNonNull(GraphQLAccount),
    description: '[Root only] Edits account type from User to Organization',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to change the type for',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true, paranoid: false });

      if (account.hasMoneyManagement) {
        throw new Error('Cannot change type of host account');
      } else if (account.type !== CollectiveType.USER) {
        throw new Error('editAccountType only works on individual profiles');
      } else if (account.data.isGuest) {
        throw new Error('editAccountType does not work on guest profiles');
      }

      const collectiveData = omit(cloneDeep(account.dataValues), ['id', 'publicId']);
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
        await account.update({ type: CollectiveType.ORGANIZATION }, { transaction });
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
    type: new GraphQLNonNull(GraphQLAccount),
    description: '[Root only] Clears the cache for a given account',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to clear the cache for',
      },
      type: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLAccountCacheType)),
        description: 'Types of cache to clear',
        defaultValue: ['CLOUDFLARE', 'GRAPHQL_QUERIES', 'CONTRIBUTORS'],
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
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
    type: new GraphQLNonNull(GraphQLMergeAccountsResponse),
    description: '[Root only] Merge two accounts, returns the result account',
    args: {
      fromAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to merge from',
      },
      toAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
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

      // Change the default timeout. We can be more permissive as this is a root action
      req.setTimeout(5 * 60 * 1000);

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
    type: new GraphQLNonNull(GraphQLBanAccountResponse),
    description: '[Root only] Ban accounts',
    args: {
      account: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput))),
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
    type: new GraphQLNonNull(new GraphQLList(GraphQLExpense)),
    description: '[Root only] A mutation to move expenses from one account to another',
    args: {
      expenses: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLExpenseReferenceInput))),
        description: 'The orders to move',
      },
      destinationAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
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
  rootAnonymizeAccount: {
    type: new GraphQLNonNull(GraphQLAccount),
    description: '[Root only] Anonymizes an account',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to anonymize',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Collective> {
      checkRemoteUserCanRoot(req);

      // Always enforce 2FA for root actions
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const stripFields = [
        'slug',
        'name',
        'legalName',
        'company',
        'description',
        'longDescription',
        'twitterHandle',
        'image',
        'backgroundImage',
        'website',
        'tags',
      ];
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      return sequelize.transaction(async transaction => {
        // Fetch the social links to make a backup, then destroy them
        const socialLinks = await account.getSocialLinks({ transaction });
        if (socialLinks.length) {
          await models.SocialLink.destroy({ where: { CollectiveId: account.id }, transaction });
        }

        // Anonymize the account
        return account.update(
          {
            ...stripFields.reduce((acc, field) => ({ ...acc, [field]: null }), {}),
            slug: `account-${uuid().substr(0, 8)}`,
            name: 'Anonymous',
            data: {
              ...account.data,
              preAnonymizedValues: pick(account.dataValues, stripFields),
              preAnonymizedSocialLinks: socialLinks.map(sl => sl.dataValues),
            },
          },
          { transaction },
        );
      });
    },
  },
  rootTransferBalance: {
    type: new GraphQLNonNull(GraphQLOrder),
    description: '[Root only] Transfers balance from one account to another, creating BALANCE_TRANSFER transactions',
    args: {
      fromAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Source account (balance goes down)',
      },
      toAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Destination account (balance goes up)',
      },
      amount: {
        type: GraphQLAmountInput,
        description: 'Amount to transfer. Defaults to full balance of source account.',
      },
      message: {
        type: GraphQLString,
        description: 'Optional reason for audit trail',
      },
    },
    async resolve(_: void, args, req: express.Request) {
      checkRemoteUserCanRoot(req);
      await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });

      const fromAccount = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
      const toAccount = await fetchAccountWithReference(args.toAccount, { throwIfMissing: true });

      if (fromAccount.id === toAccount.id) {
        throw new Error('Cannot transfer balance to the same account');
      }
      if (!fromAccount.HostCollectiveId) {
        throw new Error('Source account has no host');
      }
      if (!toAccount.HostCollectiveId) {
        throw new Error('Destination account has no host');
      }
      if (fromAccount.HostCollectiveId !== toAccount.HostCollectiveId) {
        throw new Error('Cannot transfer balance between accounts with different hosts');
      }

      const hostId = fromAccount.HostCollectiveId;
      const host = await models.Collective.findByPk(hostId);
      if (!host) {
        throw new Error(`Host collective #${hostId} not found`);
      }
      const hostCurrency = host.currency;

      const balance = await fromAccount.getBalance();
      let transferAmount: number;
      if (args.amount) {
        transferAmount = getValueInCentsFromAmountInput(args.amount, {
          expectedCurrency: hostCurrency,
          allowNilCurrency: true,
        });
        if (transferAmount > balance) {
          throw new Error(`Transfer amount (${transferAmount}) exceeds available balance (${balance})`);
        }
      } else {
        transferAmount = balance;
      }

      if (transferAmount <= 0) {
        throw new Error('Transfer amount must be greater than zero');
      }
      const description = args.message || 'Balance Transfer';

      return sequelize.transaction(async transaction => {
        const order = await models.Order.create(
          {
            status: OrderStatuses.PAID,
            processedAt: new Date(),
            FromCollectiveId: fromAccount.id,
            CollectiveId: toAccount.id,
            CreatedByUserId: req.remoteUser.id,
            totalAmount: transferAmount,
            currency: hostCurrency,
            description,
            data: { isBalanceTransfer: true, isRootBalanceTransfer: true },
          },
          { transaction },
        );

        await models.Transaction.createDoubleEntry(
          {
            CreatedByUserId: req.remoteUser.id,
            FromCollectiveId: fromAccount.id,
            CollectiveId: toAccount.id,
            HostCollectiveId: hostId,
            OrderId: order.id,
            kind: TransactionKind.BALANCE_TRANSFER,
            amount: transferAmount,
            netAmountInCollectiveCurrency: transferAmount,
            currency: hostCurrency,
            hostCurrency,
            hostCurrencyFxRate: 1,
            amountInHostCurrency: transferAmount,
            hostFeeInHostCurrency: 0,
            platformFeeInHostCurrency: 0,
            paymentProcessorFeeInHostCurrency: 0,
            description,
            clearedAt: new Date(),
            data: { isBalanceTransfer: true, isRootBalanceTransfer: true },
          },
          { sequelizeTransaction: transaction },
        );

        await models.Activity.create(
          {
            type: activities.COLLECTIVE_BALANCE_TRANSFERRED,
            UserId: req.remoteUser.id,
            FromCollectiveId: fromAccount.id,
            CollectiveId: toAccount.id,
            HostCollectiveId: hostId,
            OrderId: order.id,
            data: {
              amount: transferAmount,
              currency: hostCurrency,
              fromAccount: { id: fromAccount.id, slug: fromAccount.slug, name: fromAccount.name },
              toAccount: { id: toAccount.id, slug: toAccount.slug, name: toAccount.name },
              message: args.message,
            },
          },
          { transaction },
        );

        return order;
      });
    },
  },
};
