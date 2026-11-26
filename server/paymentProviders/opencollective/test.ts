import config from 'config';

import { maxInteger } from '../../constants/math';
import { TransactionTypes } from '../../constants/transactions';
import { getFxRate, roundCentsAmount } from '../../lib/currency';
import { getHostFee, getHostFeeSharePercent, getPlatformTip, isPlatformTipEligible } from '../../lib/payments';
import type { Order, Transaction } from '../../models';
import models from '../../models';
import type { BasePaymentProviderService } from '../types';

const paymentMethodProvider: Omit<BasePaymentProviderService, 'refundTransaction'> = {
  features: {
    recurring: true,
    waitToCharge: false,
  },

  // We don't check balance for "Added Funds"
  getBalance: () => {
    return Promise.resolve(maxInteger);
  },

  processOrder: async (order: Order): Promise<Transaction> => {
    if (!['ci', 'test'].includes(config.env)) {
      throw new Error('This Payment Method can only be used in test or ci environment.');
    }

    const host = await order.collective.getHostCollective();

    const hostFeeSharePercent = await getHostFeeSharePercent(order);
    const isSharedRevenue = !!hostFeeSharePercent;

    const amount = order.totalAmount;
    const currency = order.currency;
    const hostCurrency = host.currency;
    const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
    const amountInHostCurrency = roundCentsAmount(amount * hostCurrencyFxRate, hostCurrency);

    const platformTipEligible = await isPlatformTipEligible(order);
    const platformTip = getPlatformTip(order);
    const platformTipInHostCurrency = roundCentsAmount(platformTip * hostCurrencyFxRate, hostCurrency);

    const hostFee = await getHostFee(order);
    const hostFeeInHostCurrency = roundCentsAmount(hostFee * hostCurrencyFxRate, hostCurrency);

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
  },
};

export default paymentMethodProvider;
