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
  if (transaction.type === TransactionTypes.DEBIT) {
    transaction = await transaction.getRelatedTransaction({ type: TransactionTypes.CREDIT });
  }

  if (!transaction) {
    throw new Error('Cannot find any CREDIT transaction to refund');
  } else if (transaction.RefundTransactionId) {
    throw new Error('This transaction has already been refunded');
  }

  const collective = await models.Collective.findByPk(transaction.CollectiveId);

  const balance = await collective.getBalanceWithBlockedFunds({ currency: transaction.currency });
  if (balance < transaction.amount) {
    throw new Error(
      `Not enough funds available (${formatCurrency(
        balance,
        transaction.currency,
      )} left) to process this refund (${formatCurrency(transaction.amount, transaction.currency)})`,
    );
  }

  return createRefundTransaction(transaction, 0, null, user);
};

// We don't check balance for "Added Funds"
paymentMethodProvider.getBalance = () => {
  return Promise.resolve(maxInteger);
};

paymentMethodProvider.processOrder = async (order, options) => {
  const host = await order.collective.getHostCollective();

  if (order.paymentMethod.CollectiveId !== order.collective.HostCollectiveId) {
    throw new Error('Can only use the Host payment method to Add Funds to an hosted Collective.');
  }

  const hostFeeSharePercent = await getHostFeeSharePercent(order);
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(currency, hostCurrency);
  const amountInHostCurrency = amount * hostCurrencyFxRate;

  const hostFee = await getHostFee(order);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const paymentProcessorFee = order.data?.paymentProcessorFee || 0;
  const paymentProcessorFeeInHostCurrency =
    order.data?.paymentProcessorFeeInHostCurrency || Math.round(paymentProcessorFee * hostCurrencyFxRate) || 0;

  const transactionPayload = {
    CreatedByUserId: order.CreatedByUserId,
    FromCollectiveId: order.FromCollectiveId,
    CollectiveId: order.CollectiveId,
    PaymentMethodId: order.PaymentMethodId,
    type: TransactionTypes.CREDIT,
    kind: TransactionKind.ADDED_FUNDS,
    OrderId: order.id,
    amount,
    taxAmount: order.taxAmount,
    paymentProcessorFeeInHostCurrency,
    currency,
    hostCurrency,
    hostCurrencyFxRate,
    amountInHostCurrency,
    hostFeeInHostCurrency,
    description: order.description,
    clearedAt: order.processedAt || null,
    data: {
      // No platform tip for now here
      platformTipEligible: false,
      isSharedRevenue,
      hostFeeSharePercent,
      tax: order.data?.tax,
      invoiceTemplate: options.invoiceTemplate,
    },
  };

  return await models.Transaction.createFromContributionPayload(transactionPayload);
};

export default paymentMethodProvider;
