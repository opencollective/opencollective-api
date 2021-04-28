import { maxInteger } from '../../constants/math';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import { calcFee, getHostFeePercent, getPlatformFeePercent } from '../../lib/payments';
import models from '../../models';

const paymentMethodProvider = {};

paymentMethodProvider.features = {
  recurring: false,
  waitToCharge: false,
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

  const hostFeePercent = await getHostFeePercent(order);

  const platformFeePercent = await getPlatformFeePercent(order);

  const hostPlan = await host.getPlan();
  const hostFeeSharePercent = hostPlan?.hostFeeSharePercent;
  const isSharedRevenue = !!hostFeeSharePercent;

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
  const fxrate = await getFxRate(order.currency, host.currency);
  const totalAmountInPaymentMethodCurrency = order.totalAmount * fxrate;

  const hostFeeInHostCurrency = calcFee(order.totalAmount * fxrate, hostFeePercent);
  const platformFeeInHostCurrency = calcFee(order.totalAmount * fxrate, platformFeePercent);

  payload.transaction = {
    type: TransactionTypes.CREDIT,
    kind: TransactionKind.ADDED_FUNDS,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency: host.currency,
    hostCurrencyFxRate: fxrate,
    netAmountInCollectiveCurrency: order.totalAmount * (1 - hostFeePercent / 100),
    amountInHostCurrency: totalAmountInPaymentMethodCurrency,
    hostFeeInHostCurrency,
    platformFeeInHostCurrency,
    paymentProcessorFeeInHostCurrency: 0,
    description: order.description,
    data: {
      isSharedRevenue,
      hostFeeSharePercent,
    },
  };

  return await models.Transaction.createFromPayload(payload);
};

export default paymentMethodProvider;
