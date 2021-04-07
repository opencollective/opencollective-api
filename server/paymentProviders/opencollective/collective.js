import Promise from 'bluebird';

import { TransactionTypes } from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import { calcFee, createRefundTransaction, getHostFeePercent, getPlatformFeePercent } from '../../lib/payments';
import { formatCurrency } from '../../lib/utils';
import models from '../../models';

const paymentMethodProvider = {};

paymentMethodProvider.features = {
  recurring: true,
  waitToCharge: false,
};

// Returns the balance in the currency of the paymentMethod (ie. currency of the Collective)
paymentMethodProvider.getBalance = paymentMethod => {
  return paymentMethod.getCollective().then(collective => {
    return collective.getBalanceWithBlockedFunds();
  });
};

paymentMethodProvider.processOrder = async order => {
  if (!order.fromCollective.isActive) {
    throw new Error('Cannot use the Open Collective payment method if not active.');
  }
  if (order.paymentMethod.CollectiveId !== order.fromCollective.id) {
    throw new Error('Cannot use the Open Collective payment method to make a payment on behalf of another collective');
  }

  // Get the host of the fromCollective and collective
  const fromCollectiveHost = await order.fromCollective.getHostCollective();
  const collectiveHost = await order.collective.getHostCollective();
  if (!fromCollectiveHost) {
    throw new Error('Cannot use the Open Collective payment method without an Host.');
  }
  if (!collectiveHost) {
    throw new Error('Cannot use the Open Collective payment method to a recipient without an Host.');
  }
  if (fromCollectiveHost.id !== collectiveHost.id) {
    throw new Error(
      `Cannot use the Open Collective payment method to make a payment between different hosts: ${fromCollectiveHost.name} -> ${collectiveHost.name}`,
    );
  }

  const balance = await paymentMethodProvider.getBalance(order.paymentMethod);
  if (balance < order.totalAmount) {
    throw new Error(
      `Not enough funds available (${formatCurrency(
        balance,
        order.paymentMethod.currency,
      )} left) to execute this order (${formatCurrency(order.totalAmount, order.currency)})`,
    );
  }

  const hostFeePercent = await getHostFeePercent(order);
  const platformFeePercent = await getPlatformFeePercent(order); // it's gonna be 0 usually, unless specified in the order

  const payload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
  };

  // Different collectives on the same host may have different currencies
  // That's bad design. We should always keep the same host currency everywhere and only use the currency
  // of the collective for display purposes (using the fxrate at the time of display)
  // Anyway, until we change that, when we give money to a collective that has a different currency
  // we need to compute the equivalent using the fxrate of the day
  const fxRate = await getFxRate(order.currency, collectiveHost.currency);
  const amountInHostCurrency = order.totalAmount * fxRate;

  const feeOnTop = order.data?.platformFee || 0;
  const hostFeeInHostCurrency = calcFee((order.totalAmount - feeOnTop) * fxRate, hostFeePercent);
  const platformFeeInHostCurrency = !feeOnTop
    ? calcFee(order.totalAmount * fxRate, platformFeePercent)
    : feeOnTop * fxRate;

  payload.transaction = {
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency: collectiveHost.currency,
    hostCurrencyFxRate: fxRate,
    netAmountInCollectiveCurrency: order.totalAmount * (1 - hostFeePercent / 100),
    amountInHostCurrency,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    taxAmount: order.taxAmount,
    paymentProcessorFeeInHostCurrency: 0,
    description: order.description,
    data: {
      isFeesOnTop: order.data?.isFeesOnTop,
    },
  };

  const transactions = await models.Transaction.createFromPayload(payload);

  return transactions;
};

/**
 * Refund a given transaction by creating the opposing transaction. We don't support
 * refunds if for cross-host donations (that we stopped supporting for now).
 */
paymentMethodProvider.refundTransaction = async (transaction, user) => {
  // Get the from/to collectives.
  const collectives = await Promise.all([
    models.Collective.findByPk(transaction.FromCollectiveId),
    models.Collective.findByPk(transaction.CollectiveId),
  ]);

  const [fromCollective, collective] =
    transaction.type === TransactionTypes.CREDIT ? collectives : collectives.reverse();

  // Check if we allow refund for this one
  if (!fromCollective.HostCollectiveId) {
    throw new Error('Cannot process refunds for collectives without a host');
  } else if (fromCollective.HostCollectiveId !== collective.HostCollectiveId) {
    throw new Error('Cannot process refunds for collectives with different hosts');
  }

  const balance = await collective.getBalanceWithBlockedFunds();
  if (balance < transaction.amount) {
    throw new Error(
      `Not enough funds available (${formatCurrency(
        balance,
        collective.currency,
      )} left) to process this refund (${formatCurrency(transaction.amount, transaction.currency)})`,
    );
  }

  // Use 0 for processor fees because there's no fees for collective to collective
  // transactions within the same host.
  return await createRefundTransaction(transaction, 0, null, user);
};

export default paymentMethodProvider;
