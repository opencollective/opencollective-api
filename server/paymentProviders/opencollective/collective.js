import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import { createRefundTransaction, getHostFee, getHostFeeSharePercent, getPlatformTip } from '../../lib/payments';
import { formatCurrency } from '../../lib/utils';
import models from '../../models';

const paymentMethodProvider = {};

paymentMethodProvider.features = {
  recurring: true,
  waitToCharge: false,
};

// Returns the balance in the currency of the paymentMethod (ie. currency of the Collective)
paymentMethodProvider.getBalance = (paymentMethod, parameters = {}) => {
  return paymentMethod.getCollective().then(collective => {
    // Always send the balance in the paymentMethod.currency
    parameters.currency = paymentMethod.currency;
    return collective?.getBalance({ ...parameters, withBlockedFunds: true });
  });
};

paymentMethodProvider.processOrder = async order => {
  if (!order.fromCollective.isActive) {
    throw new Error('Cannot use the Open Collective payment method if not active.');
  } else if (!order.paymentMethod) {
    throw new Error('No payment method set on this order');
  } else if (order.paymentMethod.CollectiveId !== order.fromCollective.id) {
    throw new Error('Cannot use the Open Collective payment method to make a payment on behalf of another collective');
  }

  // Get the host of the fromCollective and collective
  const fromCollectiveHost = await order.fromCollective.getHostCollective();
  const host = await order.collective.getHostCollective();
  if (!fromCollectiveHost) {
    throw new Error('Cannot use the Open Collective payment method without an Host.');
  }
  if (!host) {
    throw new Error('Cannot use the Open Collective payment method to a recipient without an Host.');
  }
  if (fromCollectiveHost.id !== host.id) {
    throw new Error(
      `Cannot use the Open Collective payment method to make a payment between different hosts: ${fromCollectiveHost.name} -> ${host.name}`,
    );
  }

  const balance = await paymentMethodProvider.getBalance(order.paymentMethod, { currency: order.currency });
  if (balance < order.totalAmount) {
    throw new Error(
      `Not enough funds available (${formatCurrency(
        balance,
        order.paymentMethod.currency,
      )} left) to execute this order (${formatCurrency(order.totalAmount, order.currency)})`,
    );
  }

  const hostFeeSharePercent = await getHostFeeSharePercent(order);
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(order.currency, hostCurrency);
  const amountInHostCurrency = Math.round(order.totalAmount * hostCurrencyFxRate);

  // It will be usually zero but it's best to support it
  const hostFee = await getHostFee(order);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const platformTip = getPlatformTip(order);
  const platformTipInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const transactionPayload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    type: TransactionTypes.CREDIT,
    kind: order.data?.isBalanceTransfer ? TransactionKind.BALANCE_TRANSFER : TransactionKind.CONTRIBUTION,
    OrderId: order.id,
    amount,
    currency,
    hostCurrency,
    hostCurrencyFxRate,
    amountInHostCurrency,
    hostFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    data: {
      hasPlatformTip: !!platformTip,
      isSharedRevenue,
      platformTip,
      platformTipInHostCurrency,
      hostFeeSharePercent,
      tax: order.data?.tax,
    },
  };

  return models.Transaction.createFromContributionPayload(transactionPayload);
};

/**
 * Refund a given transaction by creating the opposing transaction. We don't support
 * refunds if for cross-host donations (that we stopped supporting for now).
 */
paymentMethodProvider.refundTransaction = async (transaction, user, refundedPaymentProcessorFeeInHostCurrency = 0) => {
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
  return await createRefundTransaction(transaction, refundedPaymentProcessorFeeInHostCurrency, null, user);
};

export default paymentMethodProvider;
