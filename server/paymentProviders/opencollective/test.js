import config from 'config';

import { maxInteger } from '../../constants/math.js';
import { TransactionTypes } from '../../constants/transactions.js';
import { getFxRate } from '../../lib/currency.js';
import { getHostFee, getHostFeeSharePercent, getPlatformTip, isPlatformTipEligible } from '../../lib/payments.js';
import models from '../../models/index.js';

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

  const host = await order.collective.getHostCollective();

  const hostFeeSharePercent = await getHostFeeSharePercent(order, { host });
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
  const amountInHostCurrency = Math.round(amount * hostCurrencyFxRate);

  const platformTipEligible = await isPlatformTipEligible(order, host);
  const platformTip = getPlatformTip(order);
  const platformTipInHostCurrency = Math.round(platformTip * hostCurrencyFxRate);

  const hostFee = await getHostFee(order, { host });
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const transactionPayload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount,
    currency,
    hostCurrency,
    hostCurrencyFxRate,
    amountInHostCurrency,
    hostFeeInHostCurrency,
    description: order.description,
    data: {
      hasPlatformTip: platformTip ? true : false,
      isSharedRevenue,
      platformTipEligible,
      platformTip,
      platformTipInHostCurrency,
      hostFeeSharePercent,
      tax: order.data?.tax,
    },
  };

  const transactions = await models.Transaction.createFromContributionPayload(transactionPayload);

  return transactions;
};

export default paymentMethodProvider;
