import { pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import models from '../models';

export function isPrepaidBudgetOrder(order) {
  return order.tier && order.tier.slug == 'prepaid-budget' && order.collective.slug === 'opensource';
}

export async function createPrepaidPaymentMethod(originalCreditTransaction) {
  const shareableAmount =
    originalCreditTransaction.amountInHostCurrency +
    originalCreditTransaction.hostFeeInHostCurrency +
    originalCreditTransaction.platformFeeInHostCurrency +
    originalCreditTransaction.paymentProcessorFeeInHostCurrency;

  const paymentMethodTransaction = {
    ...pick(originalCreditTransaction, ['currency', 'hostCurrency', 'CreatedByUserId']),
    description: 'Prepaid Budget',
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
    name: 'Prepaid Budget',
    service: 'opencollective',
    type: 'prepaid',
    uuid: uuid(),
    data: { HostCollectiveId: originalCreditTransaction.HostCollectiveId },
  });
}
