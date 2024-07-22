import { isNil } from 'lodash';
import { InferCreationAttributes } from 'sequelize';

import { CollectiveType } from '../../constants/collectives';
import status from '../../constants/order-status';
import { purgeCacheForCollective } from '../../lib/cache';
import { executeOrder } from '../../lib/payments';
import models, { AccountingCategory, Collective, sequelize, Tier, TransactionsImportRow, User } from '../../models';
import { AccountingCategoryAppliesTo } from '../../models/AccountingCategory';
import Order from '../../models/Order';
import { NotFound, ValidationFailed } from '../errors';
import { getOrderTaxInfoFromTaxInput } from '../v1/mutations/orders';
import { TaxInput } from '../v2/input/TaxInput';

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

export async function addFunds(order: AddFundsInput, remoteUser: User) {
  if (!remoteUser) {
    throw new Error('You need to be logged in to add fund to collective');
  }

  if (order.totalAmount < 0) {
    throw new Error('Total amount cannot be a negative value');
  }

  const { collective, fromCollective, host } = order;

  if (fromCollective.hasBudget()) {
    // Make sure logged in user is admin of the source profile, unless it doesn't have a budget (user
    // or host organization without budget activated). It's not an ideal solution though, as spammy
    // hosts could still use this to pollute user's ledgers.
    const isAdminOfFromCollective = remoteUser.isRoot() || remoteUser.isAdmin(fromCollective.id);
    if (!isAdminOfFromCollective && fromCollective.HostCollectiveId !== host.id) {
      const fromCollectiveHostId = await fromCollective.getHostCollectiveId();
      if (!remoteUser.isAdmin(fromCollectiveHostId) && !host.data?.allowAddFundsFromAllAccounts) {
        throw new Error(
          "You don't have the permission to add funds from accounts you don't own or host. Please contact support@opencollective.com if you want to enable this.",
        );
      }
    }
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
    },
  };

  if (!isNil(order.memo)) {
    orderData.data.memo = order.memo;
  }

  if (!isNil(order.processedAt)) {
    orderData['processedAt'] = order.processedAt;
  }

  if (order.tax?.rate) {
    orderData.taxAmount = Math.round(orderData.totalAmount - orderData.totalAmount / (1 + order.tax.rate));
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
      await order.transactionsImportRow.update({ OrderId: orderCreated.id, isDismissed: false }, { transaction });
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
