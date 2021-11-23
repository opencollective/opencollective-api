import Promise from 'bluebird';

import { maxInteger } from '../../constants/math';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import { createRefundTransaction, getHostFee, getHostFeeSharePercent } from '../../lib/payments';
import { formatCurrency } from '../../lib/utils';
import models from '../../models';

const paymentMethodProvider = {};

paymentMethodProvider.features = {
  recurring: false,
  waitToCharge: false,
};

paymentMethodProvider.refundTransaction = async (transaction, user) => {
  if (transaction.CollectiveId === transaction.FromCollectiveId) {
    throw new Error('Cannot refund a transaction from the same collective');
  }

  const host = await models.Collective.findByPk(transaction.CollectiveId);

  const balance = await host.getBalanceWithBlockedFunds();
  if (balance < transaction.amount) {
    throw new Error(
      `Not enough funds available (${formatCurrency(
        balance,
        host.currency,
      )} left) to process this refund (${formatCurrency(transaction.amount, transaction.currency)})`,
    );
  }

  return await createRefundTransaction(transaction, 0, null, user);
};

// We don't check balance for "Added Funds"
paymentMethodProvider.getBalance = () => {
  return Promise.resolve(maxInteger);
};

paymentMethodProvider.processOrder = async order => {
  const host = await order.collective.getHostCollective();

  if (order.paymentMethod.CollectiveId !== order.collective.HostCollectiveId) {
    throw new Error('Can only use the Host payment method to Add Funds to an hosted Collective.');
  }

  const hostFeeSharePercent = await getHostFeeSharePercent(order, host);
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
  const amountInHostCurrency = amount * hostCurrencyFxRate;

  const hostFee = await getHostFee(order, host);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const transactionPayload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    type: TransactionTypes.CREDIT,
    kind: TransactionKind.ADDED_FUNDS,
    OrderId: order.id,
    amount,
    currency,
    hostCurrency,
    hostCurrencyFxRate,
    amountInHostCurrency,
    hostFeeInHostCurrency,
    description: order.description,
    data: {
      // No platform tip for now here
      isSharedRevenue,
      hostFeeSharePercent,
      tax: order.data?.tax,
    },
  };

  return await models.Transaction.createFromContributionPayload(transactionPayload);
};

export default paymentMethodProvider;
