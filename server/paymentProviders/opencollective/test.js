import config from 'config';

import { maxInteger } from '../../constants/math';
import { TransactionTypes } from '../../constants/transactions';
import { calcFee, getHostFeePercent, getPlatformFeePercent } from '../../lib/payments';
import models from '../../models';

const paymentMethodProvider = {};

paymentMethodProvider.features = {
  recurring: true,
  waitToCharge: false,
};

// We don't check balance for "Added Funds"
paymentMethodProvider.getBalance = () => {
  return Promise.resolve(maxInteger);
};

paymentMethodProvider.processOrder = async order => {
  if (!['ci', 'test'].includes(config.env)) {
    throw new Error('This Payment Method can only be used in test or ci environment.');
  }

  const collectiveHost = await order.collective.getHostCollective();

  const hostFeePercent = await getHostFeePercent(order);
  const platformFeePercent = await getPlatformFeePercent(order);

  const payload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
  };

  const hostFeeInHostCurrency = calcFee(order.totalAmount, hostFeePercent);
  const platformFeeInHostCurrency = calcFee(order.totalAmount, platformFeePercent);

  payload.transaction = {
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency: collectiveHost.currency,
    hostCurrencyFxRate: 1,
    netAmountInCollectiveCurrency: order.totalAmount * (1 - hostFeePercent / 100),
    amountInHostCurrency: order.totalAmount,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency: 0,
    description: order.description,
  };

  const transactions = await models.Transaction.createFromPayload(payload);

  return transactions;
};

export default paymentMethodProvider;
