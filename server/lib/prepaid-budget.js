import { pick } from 'lodash-es';
import { v4 as uuid } from 'uuid';

import { TransactionKind } from '../constants/transaction-kind.js';
import models from '../models/index.js';

export function isPrepaidBudgetOrder(order) {
  return (
    order.tier?.slug === 'prepaid-budget' && ['opensource', 'foundation', 'europe'].includes(order.collective.slug)
  );
}

export async function createPrepaidPaymentMethod(originalCreditTransaction) {
  const shareableAmount =
    originalCreditTransaction.amountInHostCurrency +
    originalCreditTransaction.hostFeeInHostCurrency +
    originalCreditTransaction.platformFeeInHostCurrency +
    originalCreditTransaction.paymentProcessorFeeInHostCurrency;

  // Credit Prepaid Budget to the profile
  const paymentMethodTransaction = {
    ...pick(originalCreditTransaction, ['currency', 'hostCurrency', 'CreatedByUserId']),
    description: 'Prepaid Budget',
    amount: shareableAmount,
    amountInHostCurrency: shareableAmount,
    CollectiveId: originalCreditTransaction.FromCollectiveId,
    FromCollectiveId: originalCreditTransaction.CollectiveId,
    paymentProcessorFeeInHostCurrency: 0,
    platformFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    kind: TransactionKind.PREPAID_PAYMENT_METHOD,
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
    data: { HostCollectiveId: originalCreditTransaction.HostCollectiveId, hostFeePercent: 0 },
  });
}
