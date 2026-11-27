import type { Transaction as SequelizeTransaction } from 'sequelize';

import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { lockCollectiveBalance } from '../../lib/budget';
import { getFxRate, roundCentsAmount } from '../../lib/currency';
import { createRefundTransaction, getHostFee, getHostFeeSharePercent, getPlatformTip } from '../../lib/payments';
import { getRefundableAmountFromCollectiveInHostCurrency } from '../../lib/refunds';
import { formatCurrency } from '../../lib/utils';
import models, { type PaymentMethod, sequelize } from '../../models';
import type { BasePaymentProviderService } from '../types';

const paymentMethodProvider: BasePaymentProviderService = {
  features: {
    recurring: true,
    waitToCharge: false,
  },

  // Returns the balance in the currency of the paymentMethod (ie. currency of the Collective)
  getBalance: (paymentMethod: PaymentMethod, parameters: { currency?: string } = {}) => {
    return paymentMethod.getCollective().then(collective => {
      // Always send the balance in the paymentMethod.currency
      parameters.currency = paymentMethod.currency;
      return collective?.getBalance({ ...parameters, withBlockedFunds: true });
    });
  },

  processOrder: async order => {
    if (!order.fromCollective.isActive) {
      throw new Error('Cannot use the Open Collective payment method if not active.');
    } else if (!order.paymentMethod) {
      throw new Error('No payment method set on this order');
    } else if (order.paymentMethod.CollectiveId !== order.fromCollective.id) {
      throw new Error(
        'Cannot use the Open Collective payment method to make a payment on behalf of another collective',
      );
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

    const paymentMethodCurrency = order.paymentMethod.currency;
    const fxRate = await getFxRate(order.currency, paymentMethodCurrency);
    const totalAmountInPaymentMethodCurrency = order.totalAmount * fxRate;

    // The balance is returned in the payment method currency, which can differ from the order currency.
    // `paymentMethodProvider.getBalance` reads the same balance; the payment method belongs to `order.fromCollective`.
    const checkBalance = async (sqlTransaction?: SequelizeTransaction) => {
      const balance = await order.fromCollective.getBalance({
        currency: paymentMethodCurrency,
        withBlockedFunds: true,
        transaction: sqlTransaction,
      });
      if (balance < totalAmountInPaymentMethodCurrency) {
        throw new Error(
          `Not enough funds available (${formatCurrency(
            balance,
            paymentMethodCurrency,
          )} left) to execute this order (${formatCurrency(order.totalAmount, order.currency)})`,
        );
      }
    };

    // Unlocked pre-check: fails fast without taking the lock, and loads the FX rates the balance needs into the cache
    // so the locked check below normally doesn't wait on an FX lookup while holding the lock.
    await checkBalance();

    const hostFeeSharePercent = await getHostFeeSharePercent(order);
    const isSharedRevenue = !!hostFeeSharePercent;

    const amount = order.totalAmount;
    const currency = order.currency;
    const hostCurrency = host.currency;
    const hostCurrencyFxRate = await getFxRate(order.currency, hostCurrency);
    const amountInHostCurrency = roundCentsAmount(order.totalAmount * hostCurrencyFxRate, hostCurrency);

    // It will be usually zero but it's best to support it
    const hostFee = await getHostFee(order);
    const hostFeeInHostCurrency = roundCentsAmount(hostFee * hostCurrencyFxRate, hostCurrency);

    const platformTip = getPlatformTip(order);
    const platformTipInHostCurrency = roundCentsAmount(platformTip * hostCurrencyFxRate, hostCurrency);

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
      clearedAt: new Date(),
      data: {
        hasPlatformTip: !!platformTip,
        isSharedRevenue,
        platformTip,
        platformTipInHostCurrency,
        hostFeeSharePercent,
        tax: order.data?.tax,
      },
    };

    // Check the balance and record the ledger entries atomically: the source balance is locked for the duration
    // of the SQL transaction, so concurrent debits can't all pass the check against the same funds.
    const transaction = await sequelize.transaction(async sqlTransaction => {
      await lockCollectiveBalance(order.fromCollective.id, sqlTransaction);
      await checkBalance(sqlTransaction);
      return models.Transaction.createFromContributionPayload(transactionPayload, { sqlTransaction });
    });

    if (order.SubscriptionId) {
      const subscription = await models.Subscription.findByPk(order.SubscriptionId);
      await subscription.update({ lastChargedAt: transaction.clearedAt });
    }
    return transaction;
  },
  /**
   * Refund a given transaction by creating the opposing transaction. We don't support
   * refunds if for cross-host donations (that we stopped supporting for now).
   */
  refundTransaction: async (transaction, user, reason, refundKind, opts) => {
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

    // Use 0 for processor fees because there's no fees for collective to collective
    // transactions within the same host.
    const refund = (sqlTransaction?: SequelizeTransaction) =>
      createRefundTransaction(transaction, 0, null, user, null, null, refundKind, { sqlTransaction });

    if (opts?.ignoreBalanceCheck) {
      return await refund();
    }

    const refundableAmountFromCollective = await getRefundableAmountFromCollectiveInHostCurrency(transaction);
    const checkBalance = async (sqlTransaction?: SequelizeTransaction) => {
      const balance = await collective.getBalanceWithBlockedFunds({
        currency: transaction.hostCurrency,
        transaction: sqlTransaction,
      });
      if (balance < refundableAmountFromCollective) {
        throw new Error(
          `Not enough funds available (${formatCurrency(
            balance,
            transaction.hostCurrency,
          )} left) to process this refund (${formatCurrency(refundableAmountFromCollective, transaction.hostCurrency)})`,
        );
      }
    };

    // Same pattern as `processOrder`: unlocked pre-check, then check and debit the refunded account under its lock
    await checkBalance();
    return await sequelize.transaction(async sqlTransaction => {
      await lockCollectiveBalance(collective.id, sqlTransaction);
      await checkBalance(sqlTransaction);
      return refund(sqlTransaction);
    });
  },
};

export default paymentMethodProvider;
