import assert from 'assert';

import express from 'express';
import { GraphQLFloat, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { InferAttributes } from 'sequelize';

import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import OrderStatuses from '../../../constants/order-status';
import { purgeCacheForCollective } from '../../../lib/cache';
import { getDiffBetweenInstances } from '../../../lib/data';
import { executeOrder } from '../../../lib/payments';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models, { Collective, Order } from '../../../models';
import { addFunds, checkCanUseAccountingCategoryForOrder } from '../../common/orders';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { ValidationFailed } from '../../errors';
import { getOrderTaxInfoFromTaxInput } from '../../v1/mutations/orders';
import {
  fetchAccountingCategoryWithReference,
  GraphQLAccountingCategoryReferenceInput,
  GraphQLAccountingCategoryReferenceInputFields,
} from '../input/AccountingCategoryInput';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { AmountInputType, getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import {
  fetchOrderWithReference,
  GraphQLOrderReferenceInput,
  OrderReferenceInputGraphQLType,
} from '../input/OrderReferenceInput';
import { GraphQLTaxInput, TaxInput } from '../input/TaxInput';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput';
import {
  fetchTransactionsImportRowWithReference,
  GraphQLTransactionsImportRowReferenceInput,
  GraphQLTransactionsImportRowReferenceInputFields,
} from '../input/TransactionsImportRowReferenceInput';
import { GraphQLOrder } from '../object/Order';

type AddFundsMutationArgs = {
  fromAccount: Record<string, unknown>;
  account: Record<string, unknown>;
  tier: Record<string, unknown>;
  amount: AmountInputType;
  paymentProcessorFee?: AmountInputType;
  description: string;
  memo: string;
  processedAt: Date;
  hostFeePercent: number;
  invoiceTemplate: string;
  tax: TaxInput;
  accountingCategory: GraphQLAccountingCategoryReferenceInputFields;
  transactionsImportRow: GraphQLTransactionsImportRowReferenceInputFields;
};

const validateAddFundsArgs = ({
  account,
  fromAccount,
  args,
  paymentProcessorFee,
  totalAmount,
  host,
  tier,
  accountingCategory,
  req,
}) => {
  const accountAllowedTypes = ['ORGANIZATION', 'COLLECTIVE', 'EVENT', 'FUND', 'PROJECT'];
  if (!accountAllowedTypes.includes(account.type)) {
    throw new ValidationFailed(
      `Adding funds is only possible to the following types: ${accountAllowedTypes.join(',')}`,
    );
  }

  if (account.isFrozen()) {
    throw new ValidationFailed('Adding funds is not allowed for frozen accounts.');
  }

  // For now, we'll tolerate internal Added Funds whatever the type
  // because we found it was a practice for Independent Collectives especially
  const isInternal =
    account.id === fromAccount.id ||
    (account.ParentCollectiveId && account.ParentCollectiveId === fromAccount.id) ||
    (fromAccount.ParentCollectiveId && account.id === fromAccount.ParentCollectiveId);
  if (!isInternal) {
    const fromAccountAllowedTypes = ['USER', 'ORGANIZATION', 'VENDOR'];
    if (!fromAccountAllowedTypes.includes(fromAccount.type)) {
      throw new ValidationFailed(
        `Adding funds is only possible from the following types: ${fromAccountAllowedTypes.join(',')}`,
      );
    }
  }

  if (args.hostFeePercent < 0 || args.hostFeePercent > 100) {
    throw new ValidationFailed('hostFeePercent should be a value between 0 and 100.');
  } else if (args.tax && (args.tax.rate < 0 || args.tax.rate > 1)) {
    throw new ValidationFailed('Tax rate must be between 0 and 1');
  } else if (paymentProcessorFee > totalAmount) {
    throw new ValidationFailed('Payment processor fee cannot be higher than the total amount');
  } else if (args.hostFeePercent === 100 && paymentProcessorFee > 0) {
    throw new ValidationFailed('Payment processor fee cannot be applied when host fee is 100%');
  } else if (!totalAmount || totalAmount < 0) {
    throw new ValidationFailed('Amount should be greater than 0');
  }

  if (!host) {
    throw new ValidationFailed('Adding funds is only possible for account with a host or independent.');
  }
  if (!req.remoteUser.isAdmin(host.id) && !req.remoteUser.isRoot()) {
    throw new Error('Only an site admin or collective host admin can add fund');
  }
  if (fromAccount.type === CollectiveType.VENDOR && fromAccount.ParentCollectiveId !== host.id) {
    throw new Error('You can only add funds from a vendor account that belongs to the same host');
  }
  if (tier) {
    if (tier.CollectiveId !== account.id) {
      throw new Error(`Tier #${tier.id} is not part of collective #${account.id}`);
    }
  }
  if (accountingCategory) {
    checkCanUseAccountingCategoryForOrder(accountingCategory, host, account);
  }
};

export default {
  addFunds: {
    type: new GraphQLNonNull(GraphQLOrder),
    description: 'Add funds to the given account. Scope: "host".',
    args: {
      fromAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account that will be used as the source of the funds',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account that will receive the funds',
      },
      tier: {
        type: GraphQLTierReferenceInput,
        description: 'The tier to which the funds will be added',
      },
      amount: {
        type: new GraphQLNonNull(GraphQLAmountInput),
        description: 'The total amount of the order, including fees and taxes',
      },
      paymentProcessorFee: {
        type: GraphQLAmountInput,
        description: 'The payment processor fee amount',
      },
      hostFeePercent: {
        type: GraphQLFloat,
        description: 'The host fee percent to apply to the order, as a float between 0 and 100',
      },
      description: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'A short description of the contribution',
      },
      memo: {
        type: GraphQLString,
        description: 'A private note for the host',
      },
      processedAt: {
        type: GraphQLDateTime,
        description: 'The date at which the order was processed',
      },
      invoiceTemplate: {
        type: GraphQLString,
        description: 'The invoice template to use for this order',
      },
      tax: {
        type: GraphQLTaxInput,
        description: 'The tax to apply to the order',
      },
      accountingCategory: {
        type: GraphQLAccountingCategoryReferenceInput,
        description: 'The accounting category of this order',
      },
      transactionsImportRow: {
        type: GraphQLTransactionsImportRowReferenceInput,
        description: 'The transaction import row to associate with this order',
      },
    },
    resolve: async (_, args: AddFundsMutationArgs, req: express.Request) => {
      checkRemoteUserCanUseHost(req);

      const account: Collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const fromAccount: Collective = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
      const tier = args.tier && (await fetchTierWithReference(args.tier, { throwIfMissing: true }));
      const host = await account.getHostCollective({ loaders: req.loaders });
      const accountingCategory =
        args.accountingCategory &&
        (await fetchAccountingCategoryWithReference(args.accountingCategory, {
          throwIfMissing: true,
          loaders: req.loaders,
        }));

      // Check amounts
      const totalAmount = getValueInCentsFromAmountInput(args.amount, { expectedCurrency: account.currency });
      const paymentProcessorFee = args.paymentProcessorFee
        ? getValueInCentsFromAmountInput(args.paymentProcessorFee, { expectedCurrency: account.currency })
        : 0;

      validateAddFundsArgs({
        account,
        fromAccount,
        args,
        paymentProcessorFee,
        totalAmount,
        host,
        tier,
        accountingCategory,
        req,
      });

      // Enforce 2FA
      await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });

      const transactionsImportRow =
        args.transactionsImportRow &&
        (await fetchTransactionsImportRowWithReference(args.transactionsImportRow, {
          throwIfMissing: true,
        }));

      return addFunds(
        {
          totalAmount,
          paymentProcessorFee,
          collective: account,
          fromCollective: fromAccount,
          host,
          description: args.description,
          memo: args.memo,
          processedAt: args.processedAt,
          hostFeePercent: args.hostFeePercent,
          tier,
          invoiceTemplate: args.invoiceTemplate,
          tax: args.tax,
          transactionsImportRow,
          accountingCategory,
        },
        req.remoteUser,
      );
    },
  },
  editAddedFunds: {
    type: new GraphQLNonNull(GraphQLOrder),
    description: 'Add funds to the given account. Scope: "host".',
    args: {
      order: {
        type: new GraphQLNonNull(GraphQLOrderReferenceInput),
        description: 'The order to edit',
      },
      fromAccount: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account that will be used as the source of the funds',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'The account that will receive the funds',
      },
      tier: {
        type: GraphQLTierReferenceInput,
        description: 'The tier to which the funds will be added',
      },
      amount: {
        type: new GraphQLNonNull(GraphQLAmountInput),
        description: 'The total amount of the order, including fees and taxes',
      },
      paymentProcessorFee: {
        type: GraphQLAmountInput,
        description: 'The payment processor fee amount',
      },
      hostFeePercent: {
        type: GraphQLFloat,
        description: 'The host fee percent to apply to the order, as a float between 0 and 100',
      },
      description: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'A short description of the contribution',
      },
      memo: {
        type: GraphQLString,
        description: 'A private note for the host',
      },
      processedAt: {
        type: GraphQLDateTime,
        description: 'The date at which the order was processed',
      },
      invoiceTemplate: {
        type: GraphQLString,
        description: 'The invoice template to use for this order',
      },
      tax: {
        type: GraphQLTaxInput,
        description: 'The tax to apply to the order',
      },
      accountingCategory: {
        type: GraphQLAccountingCategoryReferenceInput,
        description: 'The accounting category of this order',
      },
    },
    resolve: async (
      _,
      args: Omit<AddFundsMutationArgs, 'transactionsImportRow'> & { order: OrderReferenceInputGraphQLType },
      req: express.Request,
    ) => {
      checkRemoteUserCanUseHost(req);

      const order = await fetchOrderWithReference(args.order, { throwIfMissing: true });
      const account: Collective = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      const fromAccount: Collective = await fetchAccountWithReference(args.fromAccount, { throwIfMissing: true });
      const tier = args.tier && (await fetchTierWithReference(args.tier, { throwIfMissing: true }));
      const host = await account.getHostCollective({ loaders: req.loaders });
      const accountingCategory =
        args.accountingCategory &&
        (await fetchAccountingCategoryWithReference(args.accountingCategory, {
          throwIfMissing: true,
          loaders: req.loaders,
        }));

      // Check amounts
      const totalAmount = getValueInCentsFromAmountInput(args.amount, { expectedCurrency: account.currency });
      const paymentProcessorFee = args.paymentProcessorFee
        ? getValueInCentsFromAmountInput(args.paymentProcessorFee, { expectedCurrency: account.currency })
        : 0;

      validateAddFundsArgs({
        account,
        fromAccount,
        args,
        paymentProcessorFee,
        totalAmount,
        host,
        tier,
        accountingCategory,
        req,
      });

      if (fromAccount.hasBudget()) {
        // Make sure logged in user is admin of the source profile, unless it doesn't have a budget (user
        // or host organization without budget activated). It's not an ideal solution though, as spammy
        // hosts could still use this to pollute user's ledgers.
        const isAdminOfFromCollective = req.remoteUser.isRoot() || req.remoteUser.isAdmin(fromAccount.id);
        if (!isAdminOfFromCollective && fromAccount.HostCollectiveId !== host.id) {
          const fromCollectiveHostId = await fromAccount.getHostCollectiveId();
          if (!req.remoteUser.isAdmin(fromCollectiveHostId) && !host.data?.allowAddFundsFromAllAccounts) {
            throw new Error(
              "You don't have the permission to add funds from accounts you don't own or host. Please contact support@opencollective.com if you want to enable this.",
            );
          }
        }
      }

      // Refund Existing Order
      const transactions = await order.getTransactions({ order: [['id', 'desc']] });
      assert(transactions.length > 0, 'No ADDED FUNDS transaction found for this order');

      await twoFactorAuthLib.enforceForAccount(req, host);
      const editedTransactions = transactions.map(t => t.id);
      await Promise.all(transactions.map(transaction => transaction.destroy()));

      const previousData = order.toJSON();
      // Update existing Order
      const orderData: Partial<InferAttributes<Order>> = {
        CreatedByUserId: req.remoteUser.id,
        FromCollectiveId: fromAccount.id,
        CollectiveId: account.id,
        totalAmount: totalAmount,
        currency: account.currency,
        description: args.description || order.description,
        status: OrderStatuses.NEW,
        TierId: tier === null ? null : tier?.id || order.TierId,
        AccountingCategoryId: accountingCategory === null ? null : accountingCategory?.id || order.AccountingCategoryId,
        processedAt: args.processedAt || order.processedAt,
        data: {
          ...order.data,
          hostFeePercent: args.hostFeePercent ?? order.data.hostFeePercent,
          paymentProcessorFee: paymentProcessorFee ?? order.data.paymentProcessorFee,
          memo: args.memo ?? order.data.memo,
        },
      };
      if (args.tax?.rate) {
        orderData.taxAmount = Math.round(orderData.totalAmount - orderData.totalAmount / (1 + args.tax.rate));
        orderData.data.tax = getOrderTaxInfoFromTaxInput(args.tax, fromAccount, account, host);
      }
      await order.update(orderData);
      const diff = getDiffBetweenInstances(order.toJSON(), previousData, ['status', 'updatedAt']);

      // Execute Order
      await executeOrder(req.remoteUser, order, {
        invoiceTemplate: args.invoiceTemplate,
        isAddedFund: true,
      });

      // Create Activity
      await models.Activity.create({
        type: ActivityTypes.ADDED_FUNDS_EDITED,
        UserId: req.remoteUser.id,
        FromCollectiveId: fromAccount.id,
        OrderId: order.id,
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          ...diff,
          editedTransactions,
        },
      });

      // Invalidate Cloudflare cache for the collective pages
      purgeCacheForCollective(account.slug);
      purgeCacheForCollective(fromAccount.slug);

      return order;
    },
  },
};
