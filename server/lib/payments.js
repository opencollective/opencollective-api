/** @module lib/payments */
import config from 'config';
import debugLib from 'debug';
import { find, get, includes, isNil, isNumber, omit, pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../constants/activities';
import { ExpenseFeesPayer } from '../constants/expense-fees-payer';
import status from '../constants/order_status';
import { PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import roles from '../constants/roles';
import tiers from '../constants/tiers';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import models, { Op } from '../models';
import TransactionSettlement, { TransactionSettlementStatus } from '../models/TransactionSettlement';
import paymentProviders from '../paymentProviders';

import { notify } from './notifications/email';
import { getFxRate } from './currency';
import emailLib from './email';
import logger from './logger';
import { getTransactionPdf } from './pdf';
import { createPrepaidPaymentMethod, isPrepaidBudgetOrder } from './prepaid-budget';
import { getNextChargeAndPeriodStartDates } from './recurring-contributions';
import { stripHTML } from './sanitize-html';
import { reportMessageToSentry } from './sentry';
import { formatAccountDetails } from './transferwise';
import { getEditRecurringContributionsUrl } from './url-utils';
import { formatCurrency, toIsoDateStr } from './utils';

const { CREDIT, DEBIT } = TransactionTypes;

const debug = debugLib('payments');

/** Check if paymentMethod has a given fully qualified name
 *
 * Payment Provider names are composed by service and type joined with
 * a dot. E.g.: `opencollective.giftcard`, `stripe.creditcard`,
 * etc. This function returns true if a *paymentMethod* instance has a
 * given *fqn*.
 *
 * @param {String} fqn is the fully qualified name to be matched.
 * @param {models.PaymentMethod} paymentMethod is the instance that
 *  will have the fully qualified name compared to the parameter
 *  *fqn*.
 * @returns {Boolean} true if *paymentMethod* has a fully qualified
 *  name that equals *fqn*.
 * @example
 * > isProvider('opencollective.giftcard', { service: 'foo', type: 'bar' })
 * false
 * > isProvider('stripe.creditcard', { service: 'stripe', type: 'creditcard' })
 * true
 */
export function isProvider(fqn, paymentMethod) {
  const pmFqn = `${paymentMethod.service}.${paymentMethod.type || 'default'}`;
  return fqn === pmFqn;
}

/** Find payment method handler
 *
 * @param {models.PaymentMethod} paymentMethod This must point to a row in the
 *  `PaymentMethods` table. That information is retrieved and the
 *  fields `service' & `type' are used to figure out which payment
 *  {service: 'stripe', type: 'creditcard'}.
 * @return the payment method's JS module.
 */
export function findPaymentMethodProvider(paymentMethod, { throwIfMissing = true } = {}) {
  const provider = get(paymentMethod, 'service') || 'opencollective';
  const methodType = get(paymentMethod, 'type') || 'default';
  let paymentMethodProvider = paymentProviders[provider];
  if (!paymentMethodProvider) {
    if (throwIfMissing) {
      throw new Error(`No payment provider found for ${provider}`);
    } else {
      return null;
    }
  }

  paymentMethodProvider = paymentMethodProvider.types[methodType];
  if (!paymentMethodProvider && throwIfMissing) {
    throw new Error(`No payment provider found for ${provider}:${methodType}`);
  }
  return paymentMethodProvider;
}

/** Process an order using its payment information
 *
 * @param {Object} order must contain a valid `paymentMethod`
 *  field. Which means that the query to select the order must include
 *  the `PaymentMethods` table.
 */
export async function processOrder(order, options) {
  const paymentMethodProvider = findPaymentMethodProvider(order.paymentMethod);
  if (get(paymentMethodProvider, 'features.waitToCharge') && !get(order, 'paymentMethod.paid')) {
    return;
  } else {
    return await paymentMethodProvider.processOrder(order, options);
  }
}

/** Refund a transaction
 *
 * @param {Object} transaction must contain a valid `PaymentMethod`
 *  field. Which means that the query to select it from the DB must
 *  include the `PaymentMethods` table.
 * @param {Object} user is an instance of the User model that will be
 *  associated to the refund transaction as who performed the refund.
 * @param {string} message a optional message to explain why the transaction is rejected
 */
export async function refundTransaction(transaction, user, message = undefined, opts = {}) {
  // Make sure to fetch PaymentMethod
  // Fetch PaymentMethod even if it's deleted
  if (!transaction.PaymentMethod && transaction.PaymentMethodId) {
    transaction.PaymentMethod = await models.PaymentMethod.findByPk(transaction.PaymentMethodId, { paranoid: false });
  }

  // If no payment method was used, it means that we're using a manual payment method
  const paymentMethodProvider = transaction.PaymentMethod
    ? findPaymentMethodProvider(transaction.PaymentMethod)
    : // TODO: Drop this in favor of findPaymentMethodProvider when persisting PaymentIntents as Payment Methods
      ['us_bank_account', 'sepa_debit'].includes(transaction.data?.charge?.payment_method_details?.type)
      ? paymentProviders.stripe.types.paymentintent
      : paymentProviders.opencollective.types.manual;

  if (!paymentMethodProvider.refundTransaction) {
    throw new Error('This payment method provider does not support refunds');
  }

  let result;

  try {
    result = await paymentMethodProvider.refundTransaction(transaction, user, message, opts);
  } catch (e) {
    if (
      (e.message.includes('has already been refunded') || e.message.includes('has been charged back')) &&
      paymentMethodProvider &&
      paymentMethodProvider.refundTransactionOnlyInDatabase
    ) {
      result = await paymentMethodProvider.refundTransactionOnlyInDatabase(transaction);
    } else {
      throw e;
    }
  }

  return result;
}

/** Calculates how much an amount's fee is worth.
 *
 * @param {Number} amount is the amount of the transaction.
 * @param {Number} fee is the percentage of the transaction.
 * @example
 * calcFee(100, 3.5); // 4.0
 * @return {Number} fee-percent of the amount rounded
 */
export function calcFee(amount, fee) {
  return Math.round((amount * fee) / 100);
}

export const buildRefundForTransaction = (t, user, data, refundedPaymentProcessorFee) => {
  const refund = pick(t, [
    'currency',
    'FromCollectiveId',
    'CollectiveId',
    'HostCollectiveId',
    'PaymentMethodId',
    'OrderId',
    'ExpenseId',
    'hostCurrencyFxRate',
    'hostCurrency',
    'hostFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'paymentProcessorFeeInHostCurrency',
    'taxAmount',
    'data.hasPlatformTip',
    'data.isFeesOnTop', // deprecated form, replaced by hasPlatformTip
    'data.tax',
    'kind',
    'isDebt',
    'PayoutMethodId',
  ]);

  refund.CreatedByUserId = user?.id || null;
  refund.description = `Refund of "${t.description}"`;
  refund.data = { ...refund.data, ...data };

  /* The refund operation moves back fees to the user's ledger so the
   * fees there should be positive. Since they're usually in negative,
   * we're just setting them to positive by adding a - sign in front
   * of it. */
  refund.hostFeeInHostCurrency = -refund.hostFeeInHostCurrency;
  refund.platformFeeInHostCurrency = -refund.platformFeeInHostCurrency;
  refund.paymentProcessorFeeInHostCurrency = -refund.paymentProcessorFeeInHostCurrency;
  refund.taxAmount = -refund.taxAmount;

  /* Amount fields. Must be calculated after tweaking all the fees */
  refund.amount = -t.amount;
  refund.amountInHostCurrency = -t.amountInHostCurrency;
  refund.netAmountInCollectiveCurrency = -models.Transaction.calculateNetAmountInCollectiveCurrency(t);
  refund.isRefund = true;

  // We're handling host fees in separate transactions
  refund.hostFeeInHostCurrency = 0;

  // Adjust refunded payment processor fee based on the fees payer
  if (refund.kind === TransactionKind.EXPENSE) {
    const feesPayer = t.data?.feesPayer || ExpenseFeesPayer.COLLECTIVE;
    if (feesPayer === ExpenseFeesPayer.PAYEE) {
      if (refundedPaymentProcessorFee && t.paymentProcessorFeeInHostCurrency) {
        // If the fee gets refunded while set on the column, we add it as a positive value on the refund transactions
        refund.paymentProcessorFeeInHostCurrency = Math.abs(refundedPaymentProcessorFee);
      } else {
        // Otherwise, payment processor fees are deducted from the refunded amount which means
        // the collective will receive the original expense amount minus payment processor fees
        refund.amountInHostCurrency += Math.abs(t.paymentProcessorFeeInHostCurrency);
        refund.amount = Math.round(refund.amountInHostCurrency / refund.hostCurrencyFxRate);
        refund.paymentProcessorFeeInHostCurrency = 0;
      }
    } else if (feesPayer === ExpenseFeesPayer.COLLECTIVE) {
      refund.amountInHostCurrency += Math.abs(t.paymentProcessorFeeInHostCurrency);
      refund.amount = Math.round(refund.amountInHostCurrency / refund.hostCurrencyFxRate);
      refund.paymentProcessorFeeInHostCurrency = 0;
    } else {
      throw new Error(`Refund not supported for feesPayer = '${feesPayer}'`);
    }
  } else {
    refund.paymentProcessorFeeInHostCurrency = 0;
  }

  // Re-compute the net amount
  refund.netAmountInCollectiveCurrency = models.Transaction.calculateNetAmountInCollectiveCurrency(refund);

  return refund;
};

export const refundPaymentProcessorFeeToCollective = async (transaction, refundTransactionGroup, data, createdAt) => {
  if (transaction.CollectiveId === transaction.HostCollectiveId) {
    return;
  }

  // Handle processor fees as separate transactions
  let processorFeeTransaction;
  if (!transaction.paymentProcessorFeeInHostCurrency) {
    processorFeeTransaction = await transaction.getPaymentProcessorFeeTransaction();
    if (!processorFeeTransaction) {
      return;
    }
  }

  const transactionCurrency = processorFeeTransaction?.currency || transaction.currency;
  const hostCurrencyFxRate = await getFxRate(transactionCurrency, transaction.hostCurrency);
  const amountInHostCurrency = Math.abs(
    processorFeeTransaction?.amountInHostCurrency || transaction.paymentProcessorFeeInHostCurrency,
  );
  const amount = Math.round(amountInHostCurrency / hostCurrencyFxRate);
  await models.Transaction.createDoubleEntry({
    type: CREDIT,
    kind: TransactionKind.PAYMENT_PROCESSOR_COVER,
    CollectiveId: transaction.CollectiveId,
    FromCollectiveId: transaction.HostCollectiveId,
    HostCollectiveId: transaction.HostCollectiveId,
    OrderId: transaction.OrderId,
    ExpenseId: transaction.ExpenseId,
    description: 'Cover of payment processor fee for refund',
    isRefund: true,
    TransactionGroup: refundTransactionGroup,
    hostCurrency: transaction.hostCurrency,
    amountInHostCurrency,
    currency: transactionCurrency,
    amount,
    netAmountInCollectiveCurrency: amount,
    hostCurrencyFxRate,
    platformFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    hostFeeInHostCurrency: 0,
    data,
    createdAt,
  });
};

export async function refundPaymentProcessorFee(
  transaction,
  user,
  refundedPaymentProcessorFee,
  transactionGroup,
  data,
) {
  // Refund processor fees if the processor sent money back
  if (refundedPaymentProcessorFee) {
    // Load processor fee transaction if using separate transactions
    let processorFeeTransaction;
    if (!transaction.paymentProcessorFeeInHostCurrency) {
      processorFeeTransaction = await transaction.getPaymentProcessorFeeTransaction();
      if (!processorFeeTransaction) {
        return;
      }
    }

    // Prevent partial refunds
    // TODO: We're now able to support this more easily, we should implement
    const processorFeeInHostCurrency =
      processorFeeTransaction?.amountInHostCurrency || transaction.paymentProcessorFeeInHostCurrency;
    if (refundedPaymentProcessorFee !== processorFeeInHostCurrency) {
      logger.error(
        `Partial processor fees refunds are not supported, got ${refundedPaymentProcessorFee} for #${transaction.id}`,
      );
      reportMessageToSentry('Partial processor fees refunds are not supported', {
        extra: { refundedPaymentProcessorFee, transaction: transaction.info },
      });
      return;
    }

    if (processorFeeTransaction) {
      const processorFeeRefund = {
        ...buildRefundForTransaction(processorFeeTransaction, user, data),
        TransactionGroup: transactionGroup,
      };

      const processorFeeRefundTransaction = await models.Transaction.createDoubleEntry(processorFeeRefund);
      await associateTransactionRefundId(processorFeeTransaction, processorFeeRefundTransaction, data);
    }
  }

  // When refunding an Expense, we need to use the DEBIT transaction which is attached to the Collective and its Host.
  const transactionToRefundPaymentProcessorFee = transaction.ExpenseId
    ? await transaction.getRelatedTransaction({ type: DEBIT })
    : transaction;

  const feesPayer = transaction.data?.feesPayer || ExpenseFeesPayer.COLLECTIVE;
  if (feesPayer === ExpenseFeesPayer.COLLECTIVE) {
    // Host take at their charge the payment processor fee that is lost when refunding a transaction
    await refundPaymentProcessorFeeToCollective(transactionToRefundPaymentProcessorFee, transactionGroup);
  }
}

export async function refundHostFee(transaction, user, refundedPaymentProcessorFee, transactionGroup, data) {
  const hostFeeTransaction = await transaction.getHostFeeTransaction();
  const buildRefund = transaction => {
    return {
      ...buildRefundForTransaction(transaction, user, data, refundedPaymentProcessorFee),
      TransactionGroup: transactionGroup,
    };
  };

  if (hostFeeTransaction) {
    const hostFeeRefund = buildRefund(hostFeeTransaction);
    const hostFeeRefundTransaction = await models.Transaction.createDoubleEntry(hostFeeRefund);
    await associateTransactionRefundId(hostFeeTransaction, hostFeeRefundTransaction, data);

    // Refund Host Fee Share
    const hostFeeShareTransaction = await transaction.getHostFeeShareTransaction();
    if (hostFeeShareTransaction) {
      const hostFeeShareRefund = buildRefund(hostFeeShareTransaction);
      const hostFeeShareRefundTransaction = await models.Transaction.createDoubleEntry(hostFeeShareRefund);
      await associateTransactionRefundId(hostFeeShareTransaction, hostFeeShareRefundTransaction, data);

      // Refund Host Fee Share Debt
      const hostFeeShareDebtTransaction = await transaction.getHostFeeShareDebtTransaction();
      if (hostFeeShareDebtTransaction) {
        const hostFeeShareSettlement = await models.TransactionSettlement.findOne({
          where: {
            TransactionGroup: transaction.TransactionGroup,
            kind: TransactionKind.HOST_FEE_SHARE_DEBT,
          },
        });
        let hostFeeShareRefundSettlementStatus = TransactionSettlementStatus.OWED;
        if (hostFeeShareSettlement.status === TransactionSettlementStatus.OWED) {
          // If the Host Fee Share is not INVOICED or SETTLED, we don't need to care about recording it.
          // Otherwise, the Host Fee Share refund will be marked as OWED and deduced from the next invoice
          await hostFeeShareSettlement.update({ status: TransactionSettlementStatus.SETTLED });
          hostFeeShareRefundSettlementStatus = TransactionSettlementStatus.SETTLED;
        }

        const hostFeeShareDebtRefund = buildRefund(hostFeeShareDebtTransaction);
        const hostFeeShareDebtRefundTransaction = await models.Transaction.createDoubleEntry(hostFeeShareDebtRefund);
        await associateTransactionRefundId(hostFeeShareDebtTransaction, hostFeeShareDebtRefundTransaction, data);
        await TransactionSettlement.createForTransaction(
          hostFeeShareDebtRefundTransaction,
          hostFeeShareRefundSettlementStatus,
        );
      }
    }
  }
}

export async function refundTax(transaction, user, transactionGroup, data) {
  const taxTransaction = await transaction.getTaxTransaction();
  if (taxTransaction) {
    const taxRefundData = {
      ...buildRefundForTransaction(taxTransaction, user, data),
      TransactionGroup: transactionGroup,
    };
    const taxRefundTransaction = await models.Transaction.createDoubleEntry(taxRefundData);
    await associateTransactionRefundId(taxTransaction, taxRefundTransaction, data);
  }
}

/** Create refund transactions
 *
 * This function creates the negative transactions after refunding an
 * existing transaction.
 *
 * If a CREDIT transaction from collective A to collective B is
 * received. Two new transactions are created:
 *
 *   1. CREDIT from collective B to collective A
 *   2. DEBIT from collective A to collective B
 *
 * @param {models.Transaction} transaction Can be either a
 *  DEBIT or a CREDIT transaction and it will generate a pair of
 *  transactions that debit the collective that was credited and
 *  credit the user that was debited.
 * @param {number} refundedPaymentProcessorFee is the amount refunded
 *  by the payment processor. If it's 0 (zero) it means that the
 *  payment processor didn't refund its fee at all. In that case, the
 *  equivalent value will be moved from the host so the user can get
 *  the full refund.
 * @param {Object} data contains the information from the payment
 *  method that should be saved within the *data* field of the
 *  transactions being created.
 */
export async function createRefundTransaction(
  transaction,
  refundedPaymentProcessorFee,
  data,
  user,
  transactionGroupId = null,
) {
  /* If the transaction passed isn't the one from the collective
   * perspective, the opposite transaction is retrieved.
   *
   * However when the transaction is between the same collective (say an
   * an expense from a collective to itself), then there will be no CREDIT
   * transaction, and therefore we skip.
   *
   * */
  if (transaction.type === DEBIT && transaction.FromCollectiveId !== transaction.CollectiveId) {
    transaction = await transaction.getRelatedTransaction({ type: CREDIT });
  }

  if (!transaction) {
    throw new Error('Cannot find any CREDIT transaction to refund');
  } else if (transaction.RefundTransactionId) {
    throw new Error('This transaction has already been refunded');
  }

  const transactionGroup = transactionGroupId || uuid();
  const buildRefund = transaction => {
    return {
      ...buildRefundForTransaction(transaction, user, data, refundedPaymentProcessorFee),
      TransactionGroup: transactionGroup,
    };
  };

  // Refund Platform Tip
  const platformTipTransaction = await transaction.getPlatformTipTransaction();
  if (platformTipTransaction) {
    const platformTipRefund = buildRefund(platformTipTransaction);
    const platformTipRefundTransaction = await models.Transaction.createDoubleEntry(platformTipRefund);
    await associateTransactionRefundId(platformTipTransaction, platformTipRefundTransaction, data);

    // Refund Platform Tip Debt
    // Tips directly collected (and legacy ones) do not have a "debt" transaction associated
    const platformTipDebtTransaction = await transaction.getPlatformTipDebtTransaction();
    if (platformTipDebtTransaction) {
      // Update tip settlement status
      const tipSettlement = await models.TransactionSettlement.findOne({
        where: {
          TransactionGroup: transaction.TransactionGroup,
          kind: TransactionKind.PLATFORM_TIP_DEBT,
        },
      });
      let tipRefundSettlementStatus = TransactionSettlementStatus.OWED;
      if (tipSettlement.status === TransactionSettlementStatus.OWED) {
        // If the tip is not INVOICED or SETTLED, we don't need to care about recording it.
        // Otherwise, the tip refund will be marked as OWED and deduced from the next invoice
        await tipSettlement.update({ status: TransactionSettlementStatus.SETTLED });
        tipRefundSettlementStatus = TransactionSettlementStatus.SETTLED;
      }

      const platformTipDebtRefund = buildRefund(platformTipDebtTransaction);
      const platformTipDebtRefundTransaction = await models.Transaction.createDoubleEntry(platformTipDebtRefund);
      await associateTransactionRefundId(platformTipDebtTransaction, platformTipDebtRefundTransaction, data);
      await TransactionSettlement.createForTransaction(platformTipDebtRefundTransaction, tipRefundSettlementStatus);
    }
  }

  // Refund Payment Processor Fee
  await refundPaymentProcessorFee(transaction, user, refundedPaymentProcessorFee, transactionGroup);

  // Refund Host Fee
  await refundHostFee(transaction, user, refundedPaymentProcessorFee, transactionGroup);

  // Refund Tax
  await refundTax(transaction, user, transactionGroup);

  // Refund main transaction
  const creditTransactionRefund = buildRefund(transaction);
  const refundTransaction = await models.Transaction.createDoubleEntry(creditTransactionRefund);
  return associateTransactionRefundId(transaction, refundTransaction, data);
}

export async function associateTransactionRefundId(transaction, refund, data) {
  const transactions = await models.Transaction.findAll({
    order: ['id'],
    where: {
      [Op.or]: [
        { TransactionGroup: transaction.TransactionGroup, kind: transaction.kind },
        { TransactionGroup: refund.TransactionGroup, kind: refund.kind },
      ],
    },
  });

  const credit = transactions.find(t => !t.isRefund && t.type === CREDIT);
  const debit = transactions.find(t => !t.isRefund && t.type === DEBIT);
  const refundCredit = transactions.find(t => t.isRefund && t.type === CREDIT);
  const refundDebit = transactions.find(t => t.isRefund && t.type === DEBIT);

  // After refunding a transaction, in some cases the data may be updated as well (stripe data changes after refunds)
  if (data) {
    debit.data = data;
    credit.data = data;
  }

  if (refundCredit && debit) {
    debit.RefundTransactionId = refundCredit.id;
    await debit.save(); // User Ledger
  }

  if (refundDebit && credit) {
    credit.RefundTransactionId = refundDebit.id;
    await credit.save(); // Collective Ledger
    refundDebit.RefundTransactionId = credit.id;
    await refundDebit.save(); // Collective Ledger
  }

  if (refundCredit && debit) {
    refundCredit.RefundTransactionId = debit.id;
    await refundCredit.save(); // User Ledger
  }

  // We need to return the same transactions we received because the
  // graphql mutation needs it to return to the user. However we have
  // to return the updated instances, not the ones we received.
  return find([refundCredit, refundDebit, debit, credit], { id: transaction.id });
}

/*
 * Send email notifications.
 *
 * Don't send emails when moving funds between a sub-collective(event/project) and its parent or
 * from between a host and one of its collectives.
 *
 * In all cases, transaction.type is CREDIT.
 *
 */
export const sendEmailNotifications = (order, transaction) => {
  debug('sendEmailNotifications');
  if (
    transaction &&
    // Check if transaction is from child (event/project) to parent (collective/fund/host).
    // fromCollective: child (event/project), collective: parent (collective/fund/host)
    order.fromCollective?.ParentCollectiveId !== order.collective?.id &&
    // Check if transaction is from parent (collective/fund/host) to child (event/project)
    // fromCollective: parent (collective/fund/host) , collective: child (event/project)
    order.fromCollective?.id !== order.collective?.ParentCollectiveId &&
    // Check if transaction is from host to one of its hosted collective/fund/project/event
    // fromCollective: host, collective: a collective/fund/project/event
    order.fromCollective?.id !== order.collective?.HostCollectiveId &&
    // Check if transaction is from a collective/fund/project/event to its host
    // fromCollective: a collective/fund/project/event, collective: host of fromCollective
    order.fromCollective?.HostCollectiveId !== order.collective?.id &&
    // Check if transaction is from a collective to itself. This happens when we add funds
    // choosing the source as itself. In this case do not send an email.
    order.fromCollective?.id !== order.collective?.id
  ) {
    sendOrderConfirmedEmail(order, transaction); // async
  } else if (order.status === status.PENDING) {
    sendOrderPendingEmail(order); // This is the one for the Contributor
    sendManualPendingOrderEmail(order); // This is the one for the Host Admins
  } else if (order.status === status.PROCESSING) {
    sendOrderProcessingEmail(order);
  }
};

export const createSubscription = async order => {
  const subscription = await models.Subscription.create({
    amount: order.totalAmount,
    interval: order.interval,
    currency: order.currency,
  });
  // The order instance doesn't have the Subscription field
  // here because it was just created and no models were
  // included so we're doing that manually here. Not the
  // cutest but works.
  order.Subscription = subscription;
  const updatedDates = getNextChargeAndPeriodStartDates('new', order);
  order.Subscription.nextChargeDate = updatedDates.nextChargeDate;
  order.Subscription.nextPeriodStart = updatedDates.nextPeriodStart || order.Subscription.nextPeriodStart;

  // Both subscriptions and one time donations are charged
  // immediately and there won't be a better time to update
  // this field after this. Please notice that it will change
  // when the issue #729 is tackled.
  // https://github.com/opencollective/opencollective/issues/729
  order.Subscription.chargeNumber = 1;
  order.Subscription.activate();
  await order.update({
    status: status.ACTIVE,
    SubscriptionId: order.Subscription.id,
  });
};

/**
 * Execute an order as user using paymentMethod
 * Note: validation of the paymentMethod happens in `models.Order.setPaymentMethod`. Not here anymore.
 * @param {Object} order { tier, description, totalAmount, currency, interval (null|month|year), paymentMethod }
 * @param {Object} options { hostFeePercent, platformFeePercent} (only for add funds and if remoteUser is admin of host or root)
 */
export const executeOrder = async (user, order, options = {}) => {
  if (!(user instanceof models.User)) {
    return Promise.reject(new Error('user should be an instance of the User model'));
  }
  if (!order) {
    return Promise.reject(new Error('No order provided'));
  }
  if (!(order instanceof models.Order)) {
    return Promise.reject(new Error('order should be an instance of the Order model'));
  }

  /* Added funds have a processedAt date by default because they are processed
     immediately. If the payment method is manual the host admin will have to
     process it manually and potentially can set a date using the confirm
     contribution modal. */
  if (order.processedAt && !options.isAddedFund && order.paymentMethod.type !== 'manual') {
    return Promise.reject(new Error(`This order (#${order.id}) has already been processed at ${order.processedAt}`));
  }
  debug('executeOrder', user.email, order.description, order.totalAmount, options);

  const payment = {
    amount: order.totalAmount,
    interval: order.interval,
    currency: order.currency,
  };

  try {
    validatePayment(payment);
  } catch (error) {
    return Promise.reject(error);
  }

  await order.populate();

  const transaction = await processOrder(order, options);
  if (transaction) {
    await order.update({
      status: status.PAID,
      processedAt: order.processedAt || new Date(),
      data: omit(order.data, ['paymentIntent']),
    });

    // Credit card charges are synchronous. If the transaction is
    // created here it means that the payment went through so it's
    // safe to create subscription after this.

    // The order will be updated to ACTIVE
    order.interval && (await createSubscription(order));

    // Register user as collective backer (don't do for internal transfers)
    // Or in the case of tickets register the user as an ATTENDEE
    if (order.fromCollective?.ParentCollectiveId !== order.collective.id) {
      await order.getOrCreateMembers();
    }

    // Create a Pre-Paid Payment Method for the prepaid budget
    if (isPrepaidBudgetOrder(order)) {
      await createPrepaidPaymentMethod(transaction);
    }
  }

  // If the user asked for it, mark the payment method as saved for future financial contributions
  if (order.data && order.data.savePaymentMethod) {
    order.paymentMethod.saved = true;
    order.paymentMethod.save();
  }

  sendEmailNotifications(order, transaction);

  // Register gift card emitter as collective backer too
  if (transaction && transaction.UsingGiftCardFromCollectiveId) {
    await order.collective.findOrAddUserWithRole(
      { id: user.id, CollectiveId: transaction.UsingGiftCardFromCollectiveId },
      roles.BACKER,
      { TierId: get(order, 'tier.id') },
      { order, skipActivity: true },
    );
  }
};

const validatePayment = payment => {
  if (payment.interval && !includes(['month', 'year'], payment.interval)) {
    throw new Error('Interval should be null, month or year.');
  }

  if (!payment.amount) {
    throw new Error('payment.amount missing');
  }
};

const sendOrderConfirmedEmail = async (order, transaction) => {
  const attachments = [];
  const { collective, interval, fromCollective, paymentMethod } = order;
  const user = await order.getUserForActivity();
  const host = await collective.getHostCollective();
  const parentCollective = await collective.getParentCollective();
  const customMessage = collective.settings?.customEmailMessage || parentCollective?.settings?.customEmailMessage;

  if (!order.tier && order.TierId) {
    order.tier = await order.getTier();
  }

  if (order?.tier?.type === tiers.TICKET) {
    return models.Activity.create({
      type: activities.TICKET_CONFIRMED,
      CollectiveId: collective.id,
      FromCollectiveId: fromCollective.id,
      OrderId: order.id,
      HostCollectiveId: host?.id,
      UserId: user.id,
      data: {
        EventCollectiveId: collective.id,
        UserId: user.id,
        recipient: { name: fromCollective.name },
        order: order.info,
        tier: order.tier.info,
        host: host ? host.info : {},
        customMessage,
      },
    });
  } else {
    // normal order
    const data = {
      order: order.info,
      transaction: transaction ? transaction.info : { createdAt: new Date() },
      user: user.info,
      collective: collective.info,
      host: host ? host.info : {},
      fromCollective: fromCollective.minimal,
      interval,
      monthlyInterval: interval === 'month',
      firstPayment: true,
      subscriptionsLink: interval && getEditRecurringContributionsUrl(fromCollective),
      customMessage,
    };

    // hit PDF service and get PDF (unless payment method type is gift card)
    if (paymentMethod?.type !== PAYMENT_METHOD_TYPE.GIFTCARD) {
      const transactionPdf = await getTransactionPdf(transaction, user);
      if (transactionPdf) {
        const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());
        attachments.push({
          filename: `transaction_${collective.slug}_${createdAtString}_${transaction.uuid}.pdf`,
          content: transactionPdf,
        });
        data.transactionPdf = true;
      }

      if (transaction.hasPlatformTip()) {
        const platformTipTransaction = await transaction.getPlatformTipTransaction();
        if (platformTipTransaction) {
          const platformTipPdf = await getTransactionPdf(platformTipTransaction, user);
          if (platformTipPdf) {
            const createdAtString = toIsoDateStr(new Date(platformTipTransaction.createdAt));
            attachments.push({
              filename: `transaction_opencollective_${createdAtString}_${platformTipTransaction.uuid}.pdf`,
              content: platformTipPdf,
            });
            data.platformTipPdf = true;
          }
        }
      }
    }

    const activity = { type: activities.ORDER_CONFIRMED, data };
    return notify.collective(activity, {
      collectiveId: data.fromCollective.id,
      role: [roles.ACCOUNTANT, roles.ADMIN],
      from: emailLib.generateFromEmailHeader(collective.name),
      attachments,
    });
  }
};

// Assumes one-time payments,
export const sendOrderPendingEmail = async order => {
  const { collective, fromCollective } = order;
  const user = order.createdByUser;
  const host = await collective.getHostCollective();
  const manualPayoutMethod = await models.PayoutMethod.findOne({
    where: { CollectiveId: host.id, data: { isManualBankTransfer: true } },
  });
  const account = manualPayoutMethod ? formatAccountDetails(manualPayoutMethod.data) : '';

  const data = {
    account,
    order: order.info,
    user: user.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
    subscriptionsLink: getEditRecurringContributionsUrl(fromCollective),
  };
  const instructions = get(host, 'settings.paymentMethods.manual.instructions');
  if (instructions) {
    const formatValues = {
      account,
      reference: order.id,
      amount: formatCurrency(order.totalAmount, order.currency, 2),
      collective: order.collective.name,
      tier: get(order, 'tier.slug') || get(order, 'tier.name'),
      // @deprecated but we still have some entries in the DB
      OrderId: order.id,
    };
    data.instructions = stripHTML(instructions).replace(/{([\s\S]+?)}/g, (match, key) => {
      if (key && !isNil(formatValues[key])) {
        return `<strong>${stripHTML(formatValues[key])}</strong>`;
      } else {
        return stripHTML(match);
      }
    });
  }
  await models.Activity.create({
    type: activities.ORDER_PENDING,
    UserId: user.id,
    CollectiveId: collective.id,
    FromCollectiveId: fromCollective.id,
    OrderId: order.id,
    HostCollectiveId: host.id,
    data,
  });
};

export const sendOrderProcessingEmail = async order => {
  const { collective, fromCollective } = order;
  const user = order.createdByUser;
  const host = await collective.getHostCollective();

  const data = {
    order: order.info,
    user: user.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
  };

  await models.Activity.create({
    type: activities.ORDER_PROCESSING,
    UserId: user.id,
    CollectiveId: collective.id,
    FromCollectiveId: fromCollective.id,
    OrderId: order.id,
    HostCollectiveId: host.id,
    data,
  });
};

export const sendOrderFailedEmail = async (order, reason) => {
  const user = order.createdByUser;
  const { collective, fromCollective } = order;
  const host = await collective.getHostCollective();

  const data = {
    order: order.info,
    user: user.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
    reason,
  };

  await models.Activity.create({
    type: activities.ORDER_PAYMENT_FAILED,
    UserId: user.id,
    CollectiveId: collective.id,
    FromCollectiveId: fromCollective.id,
    OrderId: order.id,
    HostCollectiveId: host.id,
    data,
  });
};

const sendManualPendingOrderEmail = async order => {
  const { collective, fromCollective } = order;
  const host = await collective.getHostCollective();

  let replyTo = [];
  if (fromCollective.isIncognito) {
    // We still want to surface incognito emails to the host as they often need to contact them to reconciliate the bank transfer
    const user = await models.User.findByPk(fromCollective.CreatedByUserId);
    if (user) {
      replyTo.push(user.email);
    }
  } else {
    const fromCollectiveAdmins = await fromCollective.getAdminUsers();
    replyTo = fromCollectiveAdmins.map(({ email }) => email).join(', ');
  }

  const data = {
    order: order.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
    pendingOrderLink: `${config.host.website}/${host.slug}/admin/orders?searchTerm=%23${order.id}`,
    replyTo,
  };
  return models.Activity.create({
    type: activities.ORDER_PENDING_CONTRIBUTION_NEW,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
    OrderId: order.id,
    data,
  });
};

export const sendReminderPendingOrderEmail = async order => {
  const { collective, fromCollective } = order;
  const host = await collective.getHostCollective();

  // It could be that pending orders are from pledged collective and don't have an host
  // In this case, we should skip it
  // TODO: we should be able to more precisely query orders and exclude these
  if (!host) {
    return;
  }

  const data = {
    order: order.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
    viewDetailsLink: `${config.host.website}/${host.slug}/admin/orders?searchTerm=%23${order.id}`,
  };
  return await models.Activity.create({
    type: activities.ORDER_PENDING_CONTRIBUTION_REMINDER,
    CollectiveId: order.CollectiveId,
    FromCollectiveId: order.FromCollectiveId,
    HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
    OrderId: order.id,
    data,
  });
};

export const sendExpiringCreditCardUpdateEmail = async data => {
  data = {
    ...data,
    updateDetailsLink: `${config.host.website}/paymentmethod/${data.id}/update`,
    isSystem: true,
  };
  await models.Activity.create({
    type: activities.PAYMENT_CREDITCARD_EXPIRING,
    CollectiveId: data.CollectiveId,
    data,
  });
};

export const getApplicationFee = async (order, { host = null } = {}) => {
  let applicationFee = getPlatformTip(order);

  const hostFeeSharePercent = await getHostFeeSharePercent(order, { host });
  if (hostFeeSharePercent) {
    const hostFee = await getHostFee(order, { host });
    const sharedRevenue = calcFee(hostFee, hostFeeSharePercent);
    applicationFee += sharedRevenue;
  }

  return applicationFee;
};

export const getPlatformTip = object => {
  if (!isNil(object.platformTipAmount)) {
    return object.platformTipAmount;
  }
  // Legacy form, but still being used sometime when extracting platformTip from transactionData
  if (!isNil(object.data?.platformTip)) {
    return object.data?.platformTip;
  }
  return 0;
};

export const getPlatformFeePercent = async () => {
  // Platform Fees are deprecated
  return 0;
};

export const getHostFee = async (order, { host = null } = {}) => {
  const platformTip = getPlatformTip(order);
  const taxAmount = order.taxAmount || 0;

  const hostFeePercent = await getHostFeePercent(order, { host });

  return calcFee(order.totalAmount - platformTip - taxAmount, hostFeePercent);
};

export const isPlatformTipEligible = async (order, host = null) => {
  if (!isNil(order.collective.data?.platformTips)) {
    return order.collective.data.platformTips;
  }

  if (!order.paymentMethod && order.PaymentMethodId) {
    order.paymentMethod = await order.getPaymentMethod();
  }

  // Added Funds are not eligible to Platform Tips
  if (order.paymentMethod?.service === 'opencollective' && order.paymentMethod?.type === 'host') {
    return false;
  }

  host = host || (await order.collective.getHostCollective());
  if (host) {
    const plan = await host.getPlan();
    return plan.platformTips;
  }

  return false;
};

export const getHostFeePercent = async (order, { host = null, loaders = null } = {}) => {
  const collective =
    order.collective || (await loaders?.Collective.byId.load(order.CollectiveId)) || (await order.getCollective());

  const parent = await collective.getParentCollective({ loaders });

  host = host || (await collective.getHostCollective({ loaders }));

  // Make sure payment method is available
  if (!order.paymentMethod && order.PaymentMethodId) {
    order.paymentMethod = await order.getPaymentMethod();
  }

  // No Host Fee for money going to an host itself
  if (collective.isHostAccount) {
    return 0;
  }

  const possibleValues = [
    // Fixed in the Order (Added Funds or special tiers: Pre-Paid)
    order.data?.hostFeePercent,
  ];

  if (order.paymentMethod?.service === 'opencollective' && order.paymentMethod?.type === 'manual') {
    // Fixed for Bank Transfers at collective level
    // As of December 2023, this will be only set on a selection of OCF Collectives
    // 1kproject 6%, mealsofgratitude 5%, modulo 5%
    // parentpreneur-foundation 5%, juneteenth-conference 6%
    possibleValues.push(collective.data?.bankTransfersHostFeePercent);
    // Fixed for Bank Transfers at parent level
    possibleValues.push(parent?.data?.bankTransfersHostFeePercent);

    // Custom fee is a priority over host custom one
    if (collective.data?.useCustomHostFee) {
      possibleValues.push(collective.hostFeePercent);
    }
    if (parent?.data?.useCustomHostFee) {
      possibleValues.push(parent?.hostFeePercent);
    }

    // Fixed for Bank Transfers at host level
    // As of December 2023, this is only set on a selection of Hosts:
    // foundation 8% (instead of 5%), europe 10% (instead of 8%)
    possibleValues.push(host.data?.bankTransfersHostFeePercent);
  }

  if (order.paymentMethod?.service === 'opencollective' && order.paymentMethod?.type === 'prepaid') {
    if (order.paymentMethod.data?.hostFeePercent) {
      possibleValues.push(order.paymentMethod.data?.hostFeePercent);
    }
  }

  if (order.paymentMethod?.service === 'opencollective' && order.paymentMethod?.type === 'host') {
    // Fixed for Added Funds at collective level
    possibleValues.push(collective.data?.addedFundsHostFeePercent);
    // Fixed for Added Funds at parent level
    possibleValues.push(parent?.data?.addedFundsHostFeePercent);

    // Custom fee is a priority over host custom one
    if (collective.data?.useCustomHostFee) {
      possibleValues.push(collective.hostFeePercent);
    }
    if (parent?.data?.useCustomHostFee) {
      possibleValues.push(parent?.hostFeePercent);
    }

    // Fixed for Added Funds at host level
    possibleValues.push(host.data?.addedFundsHostFeePercent);
  }

  if (order.paymentMethod?.service === 'opencollective' && order.paymentMethod?.type === 'collective') {
    // Default to 0 for Collective to Collective on the same Host
    possibleValues.push(0);
  }

  if (order.paymentMethod?.service === 'stripe') {
    // Configurable by the Host globally, at the Collective or Parent level
    // possibleValues.push(collective.data?.stripeHostFeePercent); // not used in the wild so far
    // possibleValues.push(parent?.data?.stripeHostFeePercent); // not used in the wild so far

    // Custom fee is a priority over host custom one
    if (collective.data?.useCustomHostFee) {
      possibleValues.push(collective.hostFeePercent);
    }
    if (parent?.data?.useCustomHostFee) {
      possibleValues.push(parent?.hostFeePercent);
    }

    // To help OSC transition to Platform Tips
    if (order.platformTipEligible !== true) {
      possibleValues.push(host.data?.stripeNotPlatformTipEligibleHostFeePercent);
    }

    // possibleValues.push(host.data?.stripeHostFeePercent); // not used in the wild so far
  }

  if (order.paymentMethod?.service === 'paypal') {
    // Configurable by the Host globally or at the Collective level
    // possibleValues.push(collective.data?.paypalHostFeePercent); // not used in the wild so far
    // possibleValues.push(parent?.data?.paypalHostFeePercent); // not used in the wild so far

    // Custom fee is a priority over host custom one
    if (collective.data?.useCustomHostFee) {
      possibleValues.push(collective.hostFeePercent);
    }
    if (parent?.data?.useCustomHostFee) {
      possibleValues.push(parent?.hostFeePercent);
    }

    // To help OSC transition to Platform Tips
    if (order.platformTipEligible !== true) {
      possibleValues.push(host.data?.paypalNotPlatformTipEligibleHostFeePercent);
    }

    // possibleValues.push(host.data?.paypalHostFeePercent); // not used in the wild so far
  }

  // Default for Collective
  possibleValues.push(collective.hostFeePercent);

  // Just in case, default on the platform (not used in normal operation)
  possibleValues.push(config.fees.default.hostPercent);

  // Pick the first that is set as a Number
  return possibleValues.find(isNumber);
};

export const getHostFeeSharePercent = async (order, { host = null, loaders = null } = {}) => {
  if (!host) {
    if (!order.collective) {
      order.collective = (await loaders?.Collective.byId.load(order.CollectiveId)) || (await order.getCollective());
    }
    host = await order.collective.getHostCollective({ loaders });
  }

  const plan = await host.getPlan();

  const possibleValues = [];

  if (order) {
    // Platform Tip Eligible? No Host Fee Share, that's it
    if (order.platformTipEligible === true) {
      return 0;
    }

    // Make sure payment method is available
    if (!order.paymentMethod && order.PaymentMethodId) {
      order.paymentMethod = await order.getPaymentMethod();
    }

    // Used by 1st party hosts to set Stripe and PayPal (aka "Crowfunding") share percent to zero
    // Ideally, this will not be used in the future as we'll always rely on the platformTipEligible flag to do that
    // We still have a lot of old orders were platformTipEligible is not set, so we'll keep that configuration for now

    // Assign different fees based on the payment provider
    if (order.paymentMethod?.service === 'stripe') {
      possibleValues.push(host.data?.stripeHostFeeSharePercent);
      possibleValues.push(plan?.stripeHostFeeSharePercent); // deprecated
    } else if (order.paymentMethod?.service === 'paypal') {
      possibleValues.push(host.data?.paypalHostFeeSharePercent);
      possibleValues.push(plan?.paypalHostFeeSharePercent); // deprecated
    }
  }

  // Default
  possibleValues.push(host.data?.hostFeeSharePercent);
  possibleValues.push(plan?.hostFeeSharePercent);

  // Pick the first that is set as a Number
  return possibleValues.find(isNumber);
};
