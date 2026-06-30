import express from 'express';
import { isNil } from 'lodash';
import { InferCreationAttributes } from 'sequelize';

import { CollectiveType } from '../../constants/collectives';
import status from '../../constants/order-status';
import roles from '../../constants/roles';
import { purgeCacheForCollective } from '../../lib/cache';
import { roundCentsAmount } from '../../lib/currency';
import { executeOrder } from '../../lib/payments';
import { canSeePrivateAccount } from '../../lib/private-accounts';
import { optsSanitizeHtmlForSimplified, sanitizeHTML } from '../../lib/sanitize-html';
import models, { AccountingCategory, Collective, sequelize, Tier, TransactionsImportRow, User } from '../../models';
import { AccountingCategoryAppliesTo } from '../../models/AccountingCategory';
import Order from '../../models/Order';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../errors';
import { getOrderTaxInfoFromTaxInput } from '../v1/mutations/orders';
import { TaxInput } from '../v2/input/TaxInput';

import { checkScope } from './scope-check';

type AddFundsInput = {
  totalAmount: number;
  paymentProcessorFee?: number;
  collective: Collective;
  fromCollective: Collective;
  host: Collective;
  description: string;
  memo: string;
  processedAt: Date;
  hostFeePercent: number;
  tier: Tier;
  invoiceTemplate: string;
  tax: TaxInput;
  accountingCategory?: AccountingCategory;
  transactionsImportRow?: TransactionsImportRow;
};

const MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH = 2000;

export const sanitizeMessageForContributor = (messageForContributor?: string | null): string | null => {
  if (!messageForContributor) {
    return null;
  }

  if (messageForContributor.length > 5 * MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH) {
    throw new ValidationFailed(
      `messageForContributor raw input must be at most ${5 * MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH} characters`,
    );
  }

  const sanitized = sanitizeHTML(messageForContributor, optsSanitizeHtmlForSimplified).trim();
  if (sanitized.length > MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH) {
    throw new ValidationFailed(
      `messageForContributor must be at most ${MESSAGE_FOR_CONTRIBUTOR_MAX_LENGTH} characters`,
    );
  }

  return sanitized.length ? sanitized : null;
};

/*
 * Throws if the accounting category is not allowed for this order/host
 */
export const checkCanUseAccountingCategoryForOrder = (
  accountingCategory: AccountingCategory | undefined | null,
  host: Collective,
  account: Collective,
): void => {
  const isIndependentCollective = host.type === CollectiveType.COLLECTIVE;
  if (!accountingCategory) {
    return;
  } else if (accountingCategory.CollectiveId !== host.id) {
    throw new ValidationFailed('This accounting category is not allowed for this host');
  } else if (accountingCategory.kind && !['ADDED_FUNDS', 'CONTRIBUTION'].includes(accountingCategory.kind)) {
    throw new ValidationFailed(`This accounting category is not allowed for contributions and added funds`);
  } else if (
    isIndependentCollective &&
    accountingCategory.appliesTo === AccountingCategoryAppliesTo.HOSTED_COLLECTIVES
  ) {
    throw new ValidationFailed(`This accounting category is not applicable to this account`);
  } else if (
    (accountingCategory.appliesTo === AccountingCategoryAppliesTo.HOST &&
      ![account.id, account.ParentCollectiveId].includes(host.id)) ||
    (accountingCategory.appliesTo === AccountingCategoryAppliesTo.HOSTED_COLLECTIVES &&
      [account.id, account.ParentCollectiveId].includes(host.id))
  ) {
    throw new ValidationFailed(`This accounting category is not applicable to this account`);
  }
};

export const canAddFundsFromAccount = (fromCollective: Collective, host: Collective, remoteUser: User) => {
  if (!remoteUser) {
    return false;
  } else if (remoteUser.isRoot()) {
    return true;
  } else if (!remoteUser.isAdmin(host.id)) {
    return false;
  } else if (host.isPrivate && fromCollective.HostCollectiveId !== host.id) {
    // For private accounts, funds can only be added from host-owned vendors and other hosted collectives
    return false;
  } else {
    return (
      // Allowed if admin of fromCollective
      remoteUser.isAdminOfCollective(fromCollective) ||
      // Allowed from vendors under the same host
      (fromCollective.type === CollectiveType.VENDOR && fromCollective.ParentCollectiveId === host.id) ||
      // Allowed from profiles under the same host
      fromCollective.HostCollectiveId === host.id ||
      // Allowed with special flags if the host is not private
      host.data?.allowAddFundsFromAllAccounts ||
      host.data?.isFirstPartyHost ||
      host.data?.isTrustedHost
    );
  }
};

export async function addFunds(order: AddFundsInput, remoteUser: User) {
  if (!remoteUser) {
    throw new Error('You need to be logged in to add fund to collective');
  }

  if (order.totalAmount < 0) {
    throw new Error('Total amount cannot be a negative value');
  }

  const { collective, fromCollective, host } = order;

  if (!host) {
    throw new Error('Host not found');
  } else if (!remoteUser.isAdmin(host.id)) {
    throw new Error("You don't have the permission to add funds to this host");
  } else if (!canAddFundsFromAccount(fromCollective, host, remoteUser)) {
    throw new Error(
      "You don't have the permission to add funds from accounts you don't own or host. Please contact support@opencollective.com if you want to enable this.",
    );
  }

  if (order.tier && order.tier.CollectiveId !== order.collective.id) {
    throw new Error(`Tier #${order.tier.id} is not part of collective #${order.collective.id}`);
  } else if (order.accountingCategory) {
    checkCanUseAccountingCategoryForOrder(order.accountingCategory, host, collective);
  }

  const orderData: Partial<InferCreationAttributes<Order>> = {
    CreatedByUserId: remoteUser.id,
    FromCollectiveId: fromCollective.id,
    CollectiveId: collective.id,
    totalAmount: order.totalAmount,
    currency: collective.currency,
    description: order.description,
    status: status.NEW,
    TierId: order.tier?.id || null,
    AccountingCategoryId: order.accountingCategory?.id || null,
    data: {
      hostFeePercent: order.hostFeePercent,
      paymentProcessorFee: order.paymentProcessorFee,
      ...(order.accountingCategory
        ? { valuesByRole: { hostAdmin: { accountingCategory: order.accountingCategory?.publicInfo } } }
        : {}),
    },
  };

  if (!isNil(order.memo)) {
    orderData.data.memo = order.memo;
  }

  if (!isNil(order.processedAt)) {
    orderData['processedAt'] = order.processedAt;
  }

  if (order.tax?.rate) {
    orderData.taxAmount = roundCentsAmount(
      orderData.totalAmount - orderData.totalAmount / (1 + order.tax.rate),
      orderData.currency,
    );
    orderData.data.tax = getOrderTaxInfoFromTaxInput(order.tax, fromCollective, collective, host);
  }

  // Added Funds are not eligible to Platform Tips
  orderData.platformTipEligible = false;

  // Check transactions import row
  if (order.transactionsImportRow) {
    if (order.transactionsImportRow.isProcessed()) {
      throw new ValidationFailed('This import row has already been processed');
    }

    const transactionsImport = await order.transactionsImportRow.getImport();
    if (!transactionsImport) {
      throw new NotFound('TransactionsImport not found');
    } else if (transactionsImport.CollectiveId !== host.id) {
      throw new ValidationFailed('This import does not belong to the host');
    }
  }

  // Create the order and associate it with the transaction import row if any
  const orderCreated = await sequelize.transaction(async transaction => {
    const orderCreated = await models.Order.create(orderData, { transaction });
    if (order.transactionsImportRow) {
      await order.transactionsImportRow.update({ OrderId: orderCreated.id, status: 'LINKED' }, { transaction });
    }
    return orderCreated;
  });

  const hostPaymentMethod = await host.getOrCreateHostPaymentMethod();
  await orderCreated.setPaymentMethod({ uuid: hostPaymentMethod.uuid });

  await executeOrder(remoteUser, orderCreated, {
    invoiceTemplate: order.invoiceTemplate,
    isAddedFund: true,
  });

  // Invalidate Cloudflare cache for the collective pages
  purgeCacheForCollective(collective.slug);
  purgeCacheForCollective(fromCollective.slug);

  return models.Order.findByPk(orderCreated.id);
}

/**
 * Blocks viewing an order when its destination account is private, unless the viewer may see that account
 * or has a direct stake in the order (contributor, creator, fiscal host admin).
 */
export async function assertOrderAccessibleForPrivateCollective(req: express.Request, order: Order): Promise<void> {
  const collective = await req.loaders.Collective.byId.load(order.CollectiveId);
  if (!collective?.isPrivate) {
    return;
  } else if (!req.remoteUser) {
    throw new Forbidden('This account is private. You must be a member to view it.');
  } else if (await canSeePrivateAccount(req, collective)) {
    return;
  }

  const fromCollective = await req.loaders.Collective.byId.load(order.FromCollectiveId);
  if (await canSeePrivateAccount(req, fromCollective)) {
    return;
  }

  throw new Forbidden('This account is private. You must be a member to view it.');
}

export const isOrderHostAdmin = async (req: express.Request, order: Order): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  // Prefer the already-loaded association (which may have been fetched with
  // `paranoid: false`); fall back to the loader otherwise. The loader respects
  // the model's `paranoid: true`, so a soft-deleted collective comes back as
  // `null` — guard against that to avoid a TypeError on `HostCollectiveId`.
  const toAccount = order.collective || (await req.loaders.Collective.byId.load(order.CollectiveId));
  if (!toAccount) {
    return false;
  }
  return req.remoteUser.isAdmin(toAccount.HostCollectiveId);
};

const isOrderHostAdminOrAccountant = async (req: express.Request, order: Order): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const toAccount = order.collective || (await req.loaders.Collective.byId.load(order.CollectiveId));
  if (!toAccount) {
    return false;
  }

  return req.remoteUser.hasRole([roles.ADMIN, roles.ACCOUNTANT], toAccount.HostCollectiveId);
};

export const canMarkAsPaid = async (req: express.Request, order: Order): Promise<boolean> => {
  const allowedStatuses = [status.PENDING, status.EXPIRED];
  return allowedStatuses.includes(order.status) && isOrderHostAdmin(req, order);
};

export const canMarkAsExpired = async (req: express.Request, order: Order): Promise<boolean> => {
  return order.status === status.PENDING && isOrderHostAdmin(req, order);
};

export const canEdit = async (req: express.Request, order: Order): Promise<boolean> => {
  return Boolean(
    order.status === status.PENDING && order.data?.isPendingContribution && (await isOrderHostAdmin(req, order)),
  );
};

export const canComment = async (req: express.Request, order: Order): Promise<boolean> => {
  return isOrderHostAdmin(req, order);
};

export const canSeeOrderPrivateActivities = async (req: express.Request, order: Order): Promise<boolean> => {
  return isOrderHostAdminOrAccountant(req, order);
};

const validateOrderScope = (req: express.Request, options: { throw?: boolean } = { throw: false }) => {
  if (!checkScope(req, 'orders')) {
    if (options.throw) {
      throw new Forbidden('You do not have the necessary scope to perform this action');
    } else {
      return false;
    }
  }

  return true;
};

export const canSeeOrderTransactionImportRow = async (req: express.Request, order: Order): Promise<boolean> => {
  if (!validateOrderScope(req)) {
    return false;
  } else {
    return isOrderHostAdminOrAccountant(req, order);
  }
};

export const canSetOrderTags = async (req: express.Request, order: Order): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const account = order.collective || (await req.loaders.Collective.byId.load(order.CollectiveId));
  return req.remoteUser.isAdminOfCollectiveOrHost(account);
};

/**
 * Whether the current user can cancel this order.
 *
 * Requires the order to be recurring (has a Subscription) and in a status where
 * cancellation still makes sense.
 */
export const canCancelOrder = async (
  req: express.Request,
  order: Order,
  options: { throw?: boolean } = { throw: false },
): Promise<boolean> => {
  if (!req.remoteUser) {
    if (options.throw) {
      throw new Unauthorized('You need to be logged in to manage orders');
    }
    return false;
  }

  const fromCollective = order.fromCollective || (await req.loaders.Collective.byId.load(order.FromCollectiveId));
  const isContributor = Boolean(fromCollective && req.remoteUser.isAdminOfCollective(fromCollective));
  const isHostAdmin = await isOrderHostAdmin(req, order);
  const isRootAdmin = req.remoteUser.isRoot();

  if (!isHostAdmin && !isContributor && !isRootAdmin) {
    if (options.throw) {
      throw new Unauthorized("You don't have permission to cancel this recurring contribution");
    }
    return false;
  }

  if (!order.SubscriptionId) {
    if (options.throw) {
      throw new ValidationFailed('Only recurring contributions can be cancelled');
    }
    return false;
  }

  if ([status.CANCELLED, status.PAID, status.REFUNDED, status.REJECTED].includes(order.status)) {
    if (options.throw) {
      if (order.status === status.CANCELLED) {
        throw new Error('Recurring contribution already canceled');
      } else if (order.status === status.PAID) {
        throw new Error('Cannot cancel a paid order');
      }
      throw new Forbidden('Cannot cancel a recurring contribution with this status');
    }
    return false;
  }

  return true;
};

/**
 * Whether the current user can remove the contributor (BACKER member) from the
 * collective's public profile.
 */
export const canRemoveContributorFromOrder = async (req: express.Request, order: Order): Promise<boolean> => {
  if (!(await isOrderHostAdmin(req, order))) {
    return false;
  }
  return true;
};

export const canSeeOrderCreator = async (req: express.Request, order: Order): Promise<boolean> => {
  // Host admins can always see the creator
  if (await isOrderHostAdminOrAccountant(req, order)) {
    return true;
  }

  // If incognito, only admins of the host/collective can see the creator
  const fromCollective: Collective = await req.loaders.Collective.byId.load(order.FromCollectiveId);
  if (!fromCollective.isIncognito) {
    return req.remoteUser?.isAdmin(fromCollective.HostCollectiveId);
  }

  // Otherwise the creator is public
  return true;
};

/** Whether the user can see sensitive tax fields on an order (e.g. tax ID number). */
export const canSeeOrderTaxIdNumber = async (req: express.Request, order: Order): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if ((req.userToken || req.personalToken) && !checkScope(req, 'transactions')) {
    return false;
  } else if (await isOrderHostAdminOrAccountant(req, order)) {
    return true;
  } else {
    return req.remoteUser.hasRole([roles.ACCOUNTANT, roles.ADMIN], order.FromCollectiveId);
  }
};
