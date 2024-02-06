import { isNil } from 'lodash';
import { InferCreationAttributes } from 'sequelize';

import status from '../../constants/order-status';
import { purgeCacheForCollective } from '../../lib/cache';
import * as libPayments from '../../lib/payments';
import models, { AccountingCategory, Collective, Tier, User } from '../../models';
import { OrderModelInterface } from '../../models/Order';
import { ValidationFailed } from '../errors';
import { getOrderTaxInfoFromTaxInput } from '../v1/mutations/orders';
import { TaxInput } from '../v2/input/TaxInput';

type AddFundsInput = {
  totalAmount: number;
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
};

/*
 * Throws if the accounting category is not allowed for this order/host
 */
export const checkCanUseAccountingCategoryForOrder = (
  accountingCategory: AccountingCategory | undefined | null,
  hostId: number,
): void => {
  if (!accountingCategory) {
    return;
  } else if (accountingCategory.CollectiveId !== hostId) {
    throw new ValidationFailed('This accounting category is not allowed for this host');
  } else if (accountingCategory.kind && !['ADDED_FUNDS', 'CONTRIBUTION'].includes(accountingCategory.kind)) {
    throw new ValidationFailed(`This accounting category is not allowed for contributions and added funds`);
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
    checkCanUseAccountingCategoryForOrder(order.accountingCategory, host.id);
  }

  const orderData: Partial<InferCreationAttributes<OrderModelInterface>> = {
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

  const orderCreated = await models.Order.create(orderData);

  const hostPaymentMethod = await host.getOrCreateHostPaymentMethod();
  await orderCreated.setPaymentMethod({ uuid: hostPaymentMethod.uuid });

  await libPayments.executeOrder(remoteUser, orderCreated, {
    invoiceTemplate: order.invoiceTemplate,
    isAddedFund: true,
  });

  // Invalidate Cloudflare cache for the collective pages
  purgeCacheForCollective(collective.slug);
  purgeCacheForCollective(fromCollective.slug);

  return models.Order.findByPk(orderCreated.id);
}
