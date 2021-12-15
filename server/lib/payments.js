/** @module lib/payments */
import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { find, get, includes, isNil, isNumber, omit, pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../constants/activities';
import status from '../constants/order_status';
import { PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import roles from '../constants/roles';
import tiers from '../constants/tiers';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import models, { Op } from '../models';
import TransactionSettlement, { TransactionSettlementStatus } from '../models/TransactionSettlement';
import paymentProviders from '../paymentProviders';

import { getFxRate } from './currency';
import emailLib from './email';
import logger from './logger';
import { notifyAdminsOfCollective } from './notifications';
import { getTransactionPdf } from './pdf';
import { createPrepaidPaymentMethod, isPrepaidBudgetOrder } from './prepaid-budget';
import { getNextChargeAndPeriodStartDates } from './recurring-contributions';
import { stripHTML } from './sanitize-html';
import { netAmount } from './transactions';
import { formatAccountDetails } from './transferwise';
import { formatCurrency, parseToBoolean, toIsoDateStr } from './utils';

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
export function findPaymentMethodProvider(paymentMethod) {
  const provider = get(paymentMethod, 'service') || 'opencollective';
  const methodType = get(paymentMethod, 'type') || 'default';
  let paymentMethodProvider = paymentProviders[provider];
  if (!paymentMethodProvider) {
    throw new Error(`No payment provider found for ${provider}`);
  }

  paymentMethodProvider = paymentMethodProvider.types[methodType];
  if (!paymentMethodProvider) {
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
export async function refundTransaction(transaction, user, message) {
  // If no payment method was used, it means that we're using a manual payment method
  const paymentMethodProvider = transaction.PaymentMethod
    ? findPaymentMethodProvider(transaction.PaymentMethod)
    : paymentProviders.opencollective.types.manual;

  if (!paymentMethodProvider.refundTransaction) {
    throw new Error('This payment method provider does not support refunds');
  }

  let result;

  try {
    result = await paymentMethodProvider.refundTransaction(transaction, user, message);
  } catch (e) {
    if (
      e.message.includes('has already been refunded') &&
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
    'data.isFeesOnTop',
    'data.tax',
    'kind',
    'isDebt',
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

  /* If the payment processor doesn't refund the fee, the equivalent
   * of the fee will be transferred from the host to the user so the
   * user can get the full refund. */
  if (refundedPaymentProcessorFee === 0 && !parseToBoolean(config.ledger.separateHostFees)) {
    refund.hostFeeInHostCurrency += refund.paymentProcessorFeeInHostCurrency;
    refund.paymentProcessorFeeInHostCurrency = 0;
  }

  /* Amount fields. Must be calculated after tweaking all the fees */
  refund.amount = -t.amount;
  refund.amountInHostCurrency = -t.amountInHostCurrency;
  refund.netAmountInCollectiveCurrency = -netAmount(t);
  refund.isRefund = true;

  if (parseToBoolean(config.ledger.separateHostFees)) {
    // We're handling payment processor fees and host fees in separate transactions
    refund.hostFeeInHostCurrency = 0;
    refund.paymentProcessorFeeInHostCurrency = 0;
    refund.netAmountInCollectiveCurrency = -netAmount({ ...t, paymentProcessorFeeInHostCurrency: 0 });
  }

  return refund;
};

export const refundPaymentProcessorFeeToCollective = async (transaction, refundTransactionGroup, data, createdAt) => {
  if (!transaction.paymentProcessorFeeInHostCurrency) {
    return;
  }

  const hostCurrencyFxRate = await getFxRate(transaction.currency, transaction.hostCurrency);
  const amountInHostCurrency = Math.abs(transaction.paymentProcessorFeeInHostCurrency);
  const amount = Math.round(amountInHostCurrency / hostCurrencyFxRate);
  await models.Transaction.createDoubleEntry({
    type: CREDIT,
    kind: TransactionKind.PAYMENT_PROCESSOR_COVER,
    CollectiveId: transaction.CollectiveId,
    FromCollectiveId: transaction.HostCollectiveId,
    HostCollectiveId: transaction.HostCollectiveId,
    OrderId: transaction.OrderId,
    description: 'Cover of payment processor fee for refund',
    isRefund: true,
    TransactionGroup: refundTransactionGroup,
    hostCurrency: transaction.hostCurrency,
    amountInHostCurrency,
    currency: transaction.currency,
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
export async function createRefundTransaction(transaction, refundedPaymentProcessorFee, data, user) {
  /* If the transaction passed isn't the one from the collective
   * perspective, the opposite transaction is retrieved. */
  if (transaction.type === DEBIT) {
    transaction = await transaction.getRelatedTransaction({ type: CREDIT });
  }

  if (!transaction) {
    throw new Error('Cannot find any CREDIT transaction to refund');
  } else if (transaction.RefundTransactionId) {
    throw new Error('This transaction has already been refunded');
  }

  const transactionGroup = uuid();
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
  if (parseToBoolean(config.ledger.separateHostFees)) {
    if (refundedPaymentProcessorFee && refundedPaymentProcessorFee !== transaction.paymentProcessorFeeInHostCurrency) {
      logger.error(
        `Partial processor fees refunds are not supported, got ${refundedPaymentProcessorFee} for #${transaction.id}`,
      );
    } else if (transaction.paymentProcessorFeeInHostCurrency) {
      // When refunding an Expense, we need to use the DEBIT transaction which is attached to the Collective and its Host.
      const transactionToRefundPaymentProcessorFee = transaction.ExpenseId
        ? await transaction.getRelatedTransaction({ type: DEBIT })
        : transaction;
      // Host take at their charge the payment processor fee that is lost when refunding a transaction
      await refundPaymentProcessorFeeToCollective(transactionToRefundPaymentProcessorFee, transactionGroup);
    }
  }

  // Refund Host Fee
  const hostFeeTransaction = await transaction.getHostFeeTransaction();
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

  // Refund contribution
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

  credit.RefundTransactionId = refundDebit.id;
  await credit.save(); // Collective Ledger
  refundDebit.RefundTransactionId = credit.id;
  await refundDebit.save(); // Collective Ledger

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
    // Check is transaction is from a collective/fund/project/event to its host
    // fromCollective: a collective/fund/project/event, collective: host of fromCollective
    order.fromCollective?.HostCollectiveId !== order.collective?.id
  ) {
    sendOrderConfirmedEmail(order, transaction); // async
  } else if (order.status === status.PENDING && order.paymentMethod?.type === 'crypto') {
    sendCryptoOrderProcessingEmail(order);
  } else if (order.status === status.PENDING) {
    sendOrderProcessingEmail(order); // This is the one for the Contributor
    sendManualPendingOrderEmail(order); // This is the one for the Host Admins
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
  if (!(order instanceof models.Order)) {
    return Promise.reject(new Error('order should be an instance of the Order model'));
  }
  if (!order) {
    return Promise.reject(new Error('No order provided'));
  }
  if (order.processedAt) {
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
    await order.update({ status: status.PAID, processedAt: new Date(), data: omit(order.data, ['paymentIntent']) });

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

  // Credit card charges are synchronous. If the transaction is
  // created here it means that the payment went through so it's
  // safe to create subscription after this.

  // The order will be updated to ACTIVE
  order.interval && transaction && (await createSubscription(order));
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
  const { collective, tier, interval, fromCollective, paymentMethod } = order;
  const user = order.createdByUser;
  const host = await collective.getHostCollective();

  if (tier && tier.type === tiers.TICKET) {
    return models.Activity.create({
      type: activities.TICKET_CONFIRMED,
      CollectiveId: collective.id,
      data: {
        EventCollectiveId: collective.id,
        UserId: user.id,
        recipient: { name: fromCollective.name },
        order: order.activity,
        tier: tier && tier.info,
        host: host ? host.info : {},
      },
    });
  } else {
    // normal order
    const relatedCollectives = await order.collective.getRelatedCollectives(3, 0);
    const data = {
      order: order.activity,
      transaction: pick(transaction, ['createdAt', 'uuid']),
      user: user.info,
      collective: collective.info,
      host: host ? host.info : {},
      fromCollective: fromCollective.minimal,
      interval,
      relatedCollectives,
      monthlyInterval: interval === 'month',
      firstPayment: true,
      subscriptionsLink: interval && `${config.host.website}/${fromCollective.slug}/recurring-contributions`,
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

    const emailOptions = {
      from: `${collective.name} <no-reply@${collective.slug}.opencollective.com>`,
      attachments,
    };

    const activity = {
      type: 'thankyou',
      data,
    };

    return notifyAdminsOfCollective(data.fromCollective.id, activity, emailOptions);
  }
};

// Sends an email when a deposit address is shown to the user in the crypto contribution flow.
// Here a pending order is created.
const sendCryptoOrderProcessingEmail = async order => {
  if (order?.paymentMethod?.data?.depositAddress) {
    const { collective, fromCollective } = order;
    const user = order.createdByUser;
    const host = await collective.getHostCollective();

    const data = {
      order: order.info,
      depositAddress: order.paymentMethod.data.depositAddress,
      collective: collective.info,
      host: host.info,
      fromCollective: fromCollective.activity,
      pledgeAmount: order.data.thegivingblock.pledgeAmount,
      pledgeCurrency: order.data.thegivingblock.pledgeCurrency,
    };

    return emailLib.send('order.crypto.processing', user.email, data, {
      from: `${collective.name} <no-reply@${collective.slug}.opencollective.com>`,
    });
  }
};

// Assumes one-time payments,
export const sendOrderProcessingEmail = async order => {
  const { collective, fromCollective } = order;
  const user = order.createdByUser;
  const host = await collective.getHostCollective();
  const parentCollective = await collective.getParentCollective();
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
    subscriptionsLink: `${config.host.website}/${fromCollective.slug}/recurring-contributions`,
  };
  const instructions = get(host, 'settings.paymentMethods.manual.instructions');
  if (instructions) {
    const formatValues = {
      account,
      reference: order.id,
      amount: formatCurrency(order.totalAmount, order.currency, 2),
      collective: parentCollective ? `${parentCollective.slug} event` : order.collective.slug,
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
  return emailLib.send('order.processing', user.email, data, {
    from: `${collective.name} <no-reply@${collective.slug}.opencollective.com>`,
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
  };

  return notifyAdminsOfCollective(host.id, { type: 'order.new.pendingFinancialContribution', data }, { replyTo });
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

  return notifyAdminsOfCollective(host.id, { type: 'order.reminder.pendingFinancialContribution', data });
};

export const sendExpiringCreditCardUpdateEmail = async data => {
  data = {
    ...data,
    updateDetailsLink: `${config.host.website}/${data.slug}/paymentmethod/${data.id}/update`,
  };

  return emailLib.send('payment.creditcard.expiring', data.email, data);
};

export const getApplicationFee = async (order, host = null) => {
  let applicationFee = getPlatformTip(order);

  const hostFeeSharePercent = await getHostFeeSharePercent(order, host);
  if (hostFeeSharePercent) {
    const hostFee = await getHostFee(order, host);
    const sharedRevenue = hostFeeSharePercent ? calcFee(hostFee, hostFeeSharePercent) : 0;
    applicationFee += sharedRevenue;
  }

  return applicationFee;
};

export const getPlatformTip = object => {
  if (object.data?.platformTip) {
    return object.data?.platformTip;
  }
  if (object.data?.platformFee) {
    return object.data?.platformFee;
  }
  // Compatibility with some older tests
  // TODO: doesn't seem accurate in multi currency
  if (object.data?.isFeesOnTop && !isNil(object.platformFeeInHostCurrency)) {
    return Math.abs(object.platformFeeInHostCurrency);
  }
  return 0;
};

export const getPlatformFeePercent = async () => {
  // Platform Fees are deprecated
  return 0;
};

export const getHostFee = async (order, host = null) => {
  const platformTip = getPlatformTip(order);

  const hostFeePercent = await getHostFeePercent(order, host);

  return calcFee(order.totalAmount - platformTip, hostFeePercent);
};

export const isPlatformTipEligible = async (order, host = null) => {
  if (!isNil(order.collective.data?.platformTips)) {
    return order.collective.data.platformTips;
  }

  host = host || (await order.collective.getHostCollective());
  if (host) {
    const plan = await host.getPlan();
    return plan.platformTips;
  }

  return false;
};

export const getHostFeePercent = async (order, host = null) => {
  host = host || (await order.collective.getHostCollective());

  // No Host Fee for money going to an host itself
  if (order.collective.isHostAccount) {
    return 0;
  }

  const possibleValues = [
    // Fixed in the Order (special tiers: BackYourStack, Pre-Paid)
    order.data?.hostFeePercent,
  ];

  if (order.paymentMethod.service === 'opencollective' && order.paymentMethod.type === 'manual') {
    // Fixed for Bank Transfers at collective level
    // As of August 2020, this will be only set on a selection of Collective (some foundation collectives 5%)
    possibleValues.push(order.collective.data?.bankTransfersHostFeePercent);
    // Fixed for Bank Transfers at host level
    // As of August 2020, this will be only set on a selection of Hosts (foundation 8%)
    possibleValues.push(host.data?.bankTransfersHostFeePercent);
  }

  if (order.paymentMethod.service === 'opencollective' && order.paymentMethod.type === 'prepaid') {
    if (order.paymentMethod.data?.hostFeePercent) {
      possibleValues.push(order.paymentMethod.data?.hostFeePercent);
    }
  }

  if (order.paymentMethod.service === 'opencollective') {
    // Default to 0 for this kind of payments
    if (order.paymentMethod.type === 'collective' || order.paymentMethod.type === 'host') {
      possibleValues.push(0);
    }
  }

  if (order.paymentMethod.service === 'stripe') {
    // Configurable by the Host globally or at the Collective level
    possibleValues.push(order.collective.data?.creditCardHostFeePercent);
    possibleValues.push(host.data?.creditCardHostFeePercent);
  }

  if (order.paymentMethod.service === 'paypal') {
    // Configurable by the Host globally or at the Collective level
    possibleValues.push(order.collective.data?.paypalHostFeePercent);
    possibleValues.push(host.data?.paypalHostFeePercent);
  }

  // Default for Collective
  possibleValues.push(order.collective.hostFeePercent);

  // Just in case, default on the platform (not used in normal operation)
  possibleValues.push(config.fees.default.hostPercent);

  // Pick the first that is set as a Number
  return possibleValues.find(isNumber);
};

export const getHostFeeSharePercent = async (order, host = null) => {
  host = host || (await order.collective.getHostCollective());

  const plan = await host.getPlan();

  const possibleValues = [];

  if (order) {
    if (order.paymentMethod?.service === 'stripe' && order.paymentMethod?.type === 'creditcard') {
      possibleValues.push(plan?.creditCardHostFeeSharePercent);
    }

    if (order.paymentMethod?.service === 'paypal' && order.paymentMethod?.type === 'payment') {
      possibleValues.push(plan?.paypalHostFeeSharePercent);
    }
  }

  // Default
  possibleValues.push(plan?.hostFeeSharePercent);

  // Pick the first that is set as a Number
  return possibleValues.find(isNumber);
};
