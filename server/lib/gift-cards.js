import { v4 as uuid } from 'uuid';
import { pick } from 'lodash';

import models from '../models';

export function isGiftCardPrepaidBudgetOrder(order) {
  return order.tier && order.tier.slug == 'gift-card-budget' && order.collective.slug === 'osc';
}

export async function createGiftCardPrepaidPaymentMethod(originalCreditTransaction) {
  const shareableAmount =
    originalCreditTransaction.amountInHostCurrency +
    originalCreditTransaction.hostFeeInHostCurrency +
    originalCreditTransaction.platformFeeInHostCurrency +
    originalCreditTransaction.paymentProcessorFeeInHostCurrency;

  const paymentMethodTransaction = {
    ...pick(originalCreditTransaction, ['currency', 'hostCurrency', 'CreatedByUserId']),
    description: 'Prepaid Payment Method for Gift Card Budget',
    amount: shareableAmount,
    CollectiveId: originalCreditTransaction.FromCollectiveId,
    FromCollectiveId: originalCreditTransaction.CollectiveId,
    paymentProcessorFeeInHostCurrency: 0,
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
  };

  await models.Transaction.createDoubleEntry(paymentMethodTransaction);

  return models.PaymentMethod.create({
    initialBalance: shareableAmount,
    currency: originalCreditTransaction.currency,
    CollectiveId: originalCreditTransaction.FromCollectiveId,
    name: 'Prepaid Gift Card Budget',
    service: 'opencollective',
    type: 'prepaid',
    uuid: uuid(),
    data: { HostCollectiveId: originalCreditTransaction.HostCollectiveId },
  });
}
