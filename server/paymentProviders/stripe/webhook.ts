/* eslint-disable camelcase */
import config from 'config';
import debugLib from 'debug';
import { Request } from 'express';
import { get, omit } from 'lodash';
import moment from 'moment';
import { Transaction } from 'sequelize';
import type Stripe from 'stripe';
import { v4 as uuid } from 'uuid';

import ActivityTypes from '../../constants/activities';
import { Service } from '../../constants/connected-account';
import { SupportedCurrency } from '../../constants/currencies';
import FEATURE from '../../constants/feature';
import OrderStatuses from '../../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE, PAYMENT_METHOD_TYPES } from '../../constants/paymentMethods';
import { RefundKind } from '../../constants/refund-kind';
import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import { getFxRate, isSupportedCurrency } from '../../lib/currency';
import logger from '../../lib/logger';
import {
  createRefundTransaction,
  createSubscription,
  sendEmailNotifications,
  sendOrderFailedEmail,
} from '../../lib/payments';
import { reportMessageToSentry } from '../../lib/sentry';
import stripe, { getDashboardObjectIdURL } from '../../lib/stripe';
import { createTransactionsFromPaidStripeExpense, getPaymentProcessorFeeVendor } from '../../lib/transactions';
import models, { sequelize } from '../../models';
import { ExpenseStatus } from '../../models/Expense';
import Order from '../../models/Order';
import PaymentMethod from '../../models/PaymentMethod';

import { getVirtualCardForTransaction } from './../utils';
import { createChargeTransactions, createPaymentMethod, UNKNOWN_ERROR_MSG, userFriendlyErrorMessage } from './common';
import * as virtualcard from './virtual-cards';

const debug = debugLib('stripe');

export async function createOrUpdatePaymentMethod(
  PaymentMethodCollectiveId: number,
  CreatedByUserId: number,
  stripeAccount: string,
  paymentIntent: Stripe.PaymentIntent,
  { transaction }: { transaction?: Transaction } = {},
): Promise<PaymentMethod> {
  const stripePaymentMethodId =
    typeof paymentIntent.payment_method === 'string' ? paymentIntent.payment_method : paymentIntent.payment_method?.id;

  const matchingPaymentMethod = await models.PaymentMethod.findOne({
    where: {
      CollectiveId: PaymentMethodCollectiveId,
      data: {
        stripePaymentMethodId,
        stripeAccount,
      },
    },
    transaction,
  });

  if (matchingPaymentMethod) {
    return matchingPaymentMethod;
  }

  const stripePaymentMethod = await stripe.paymentMethods.retrieve(stripePaymentMethodId, {
    stripeAccount,
  });

  const stripeCustomer = stripePaymentMethod.customer
    ? typeof stripePaymentMethod.customer === 'string'
      ? stripePaymentMethod.customer
      : stripePaymentMethod.customer?.id
    : typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : paymentIntent.customer?.id;

  const pm = await createPaymentMethod(
    {
      stripeAccount,
      stripePaymentMethod,
      stripeCustomer,
      originPaymentIntent: paymentIntent,
      CollectiveId: PaymentMethodCollectiveId,
      CreatedByUserId: CreatedByUserId,
    },
    { transaction },
  );

  return pm;
}

export async function createOrUpdateOrderStripePaymentMethod(
  order: Order,
  stripeAccount: string,
  paymentIntent: Stripe.PaymentIntent,
): Promise<PaymentMethod> {
  const stripePaymentMethodId =
    typeof paymentIntent.payment_method === 'string' ? paymentIntent.payment_method : paymentIntent.payment_method?.id;

  const orderPaymentMethod = await models.PaymentMethod.findByPk(order.PaymentMethodId);
  // order paymentMethod already saved.
  if (orderPaymentMethod?.data?.stripePaymentMethodId === stripePaymentMethodId) {
    return orderPaymentMethod;
  }

  const pm = await createOrUpdatePaymentMethod(
    order.FromCollectiveId,
    order.CreatedByUserId,
    stripeAccount,
    paymentIntent,
  );
  await order.update({
    PaymentMethodId: pm.id,
  });

  return pm;
}

export const mandateUpdated = async (event: Stripe.Event) => {
  const stripeAccount = event.account ?? config.stripe.accountId;

  const stripeMandate = event.data.object as Stripe.Mandate;

  const stripePaymentMethodId =
    typeof stripeMandate.payment_method === 'string' ? stripeMandate.payment_method : stripeMandate.payment_method.id;

  await sequelize.transaction(async transaction => {
    const paymentMethod = await models.PaymentMethod.findOne({
      where: {
        data: {
          stripePaymentMethodId,
        },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!paymentMethod) {
      const stripePaymentMethod = await stripe.paymentMethods.retrieve(stripePaymentMethodId, {
        stripeAccount,
      });

      if (!PAYMENT_METHOD_TYPES.includes(stripePaymentMethod.type as PAYMENT_METHOD_TYPE)) {
        return;
      }

      await createPaymentMethod(
        {
          stripePaymentMethod,
          stripeCustomer:
            typeof stripePaymentMethod.customer === 'string'
              ? stripePaymentMethod.customer
              : stripePaymentMethod.customer?.id,
          stripeAccount,
          extraData: {
            stripeMandate,
          },
        },
        { transaction },
      );

      return;
    } else {
      await paymentMethod.update(
        {
          saved: stripeMandate.type === 'multi_use' && stripeMandate.status !== 'inactive',
          data: {
            ...paymentMethod.data,
            stripeMandate,
          },
        },
        {
          transaction,
        },
      );
    }
    return;
  });
};

export async function paymentIntentSucceeded(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  const target = await paymentIntentTarget(paymentIntent);

  switch (target) {
    case 'EXPENSE': {
      return handleExpensePaymentIntentSucceeded(event);
    }
    case 'ORDER':
    default: {
      return handleOrderPaymentIntentSucceeded(event);
    }
  }
}

const handleOrderPaymentIntentSucceeded = async (event: Stripe.Event) => {
  const stripeAccount = event.account ?? config.stripe.accountId;
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  let charge = paymentIntent.latest_charge || ((paymentIntent as any).charges?.data?.[0] as Stripe.Charge);
  if (typeof charge === 'string') {
    charge = await stripe.charges.retrieve(charge, { stripeAccount });
  }

  const order = await models.Order.findOne({
    where: {
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.debug(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  // If charge was already processed, ignore event. (Potential edge-case: if the webhook is called while processing a 3DS validation)
  const existingChargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: charge.id } } },
  });
  if (existingChargeTransaction) {
    logger.info(
      `Stripe Webhook: ${existingChargeTransaction.OrderId} already processed charge ${charge.id}, ignoring event ${event.id}`,
    );
    return;
  }

  await createOrUpdateOrderStripePaymentMethod(order, stripeAccount, paymentIntent);

  const transaction = await createChargeTransactions(charge, { order });
  const sideEffects: Promise<unknown>[] = [
    order.update({
      status: !order.SubscriptionId ? OrderStatuses.PAID : OrderStatuses.ACTIVE,
      processedAt: new Date(),
      data: {
        ...omit(order.data, 'paymentIntent'),
        previousPaymentIntents: [...(order.data.previousPaymentIntents ?? []), paymentIntent],
      },
    }),
    order.getOrCreateMembers(),
  ];

  // after successful first payment of a recurring subscription where the payment confirmation is async
  // and the subscription is managed by us.
  if (order.interval && !order.SubscriptionId) {
    sideEffects.push(createSubscription(order, { lastChargedAt: transaction.clearedAt || transaction.createdAt }));
  } else if (order.SubscriptionId) {
    const subscription = await models.Subscription.findByPk(order.SubscriptionId);
    sideEffects.push(subscription.update({ lastChargedAt: transaction.clearedAt }));
  }

  sendEmailNotifications(order, transaction);
  await Promise.all(sideEffects);
};

async function handleExpensePaymentIntentSucceeded(event: Stripe.Event) {
  const stripeAccount = event.account ?? config.stripe.accountId;
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  let charge = paymentIntent.latest_charge;
  if (typeof charge === 'string') {
    charge = await stripe.charges.retrieve(charge, { expand: ['balance_transaction'] }, { stripeAccount });
  }

  const [expense, shouldMarkPaid] = await sequelize.transaction(async transaction => {
    const expense = await models.Expense.findOne({
      lock: transaction.LOCK.UPDATE,
      transaction,
      where: {
        data: { paymentIntent: { id: paymentIntent.id } },
      },
      include: [
        { association: 'collective', required: true },
        {
          association: 'fromCollective',
          required: true,
          include: [
            {
              association: 'host',
              required: true,
            },
          ],
        },
      ],
    });

    if (!expense) {
      logger.debug(`Stripe Webhook: Could not find Expense for Payment Intent ${paymentIntent.id}`);
      return [expense, false];
    }

    const existingChargeTransaction = await models.Transaction.findOne({
      where: { data: { charge: { id: charge.id } } },
      transaction,
    });
    if (existingChargeTransaction) {
      logger.info(
        `Stripe Webhook: Expense ${existingChargeTransaction.ExpenseId} already processed charge ${charge.id}, ignoring event ${event.id}`,
      );
      return [expense, false];
    }

    const pm = await createOrUpdatePaymentMethod(
      expense.CollectiveId,
      expense.lastEditedById,
      stripeAccount,
      paymentIntent,
      { transaction },
    );

    const balanceTransaction = charge.balance_transaction as Stripe.BalanceTransaction;
    await expense.update(
      {
        data: {
          ...omit(expense.data, 'paymentIntent'),
          previousPaymentIntents: [...(expense.data.previousPaymentIntents ?? []), paymentIntent],
        },
        PaymentMethodId: pm.id,
        feesPayer: 'PAYEE',
      },
      { transaction },
    );
    await createTransactionsFromPaidStripeExpense(expense, balanceTransaction, charge, {
      sequelizeTransaction: transaction,
    });

    return [expense, true];
  });

  if (shouldMarkPaid) {
    await expense.markAsPaid();
  }
}

async function paymentIntentTarget(paymentIntent: Stripe.PaymentIntent): Promise<'ORDER' | 'EXPENSE'> {
  const result = await sequelize.query(
    `
    (
      SELECT 'ORDER' as "target"
      FROM "Orders" where "data"#>>'{paymentIntent,id}' = :paymentIntentId
      AND "deletedAt" IS NULL LIMIT 1
    )
    UNION ALL
    (
      SELECT 'EXPENSE' as "target"
      FROM "Expenses" where "data"#>>'{paymentIntent,id}' = :paymentIntentId
      AND "deletedAt" IS NULL LIMIT 1
    )
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      replacements: {
        paymentIntentId: paymentIntent.id,
      },
    },
  );

  if (!result?.length) {
    return 'ORDER';
  }

  return result[0].target;
}

export const paymentIntentProcessing = async (event: Stripe.Event) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  const target = await paymentIntentTarget(paymentIntent);

  switch (target) {
    case 'EXPENSE': {
      return handleExpensePaymentIntentProcessing(event);
    }
    case 'ORDER':
    default: {
      return handleOrderPaymentIntentProcessing(event);
    }
  }
};

async function handleOrderPaymentIntentProcessing(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  const stripeAccount = event.account ?? config.stripe.accountId;

  await sequelize.transaction(async transaction => {
    const order = await models.Order.findOne({
      where: {
        status: [OrderStatuses.NEW, OrderStatuses.PROCESSING, OrderStatuses.ERROR, OrderStatuses.ACTIVE],
        data: { paymentIntent: { id: paymentIntent.id } },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
      include: [
        { association: 'collective', required: true },
        { association: 'fromCollective', required: true },
        { association: 'createdByUser', required: true },
      ],
    });

    if (!order) {
      logger.debug(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
      return;
    }

    let pm = await models.PaymentMethod.findOne({
      where: {
        data: {
          stripePaymentMethodId: paymentIntent.payment_method,
          stripeAccount,
        },
      },
      transaction,
    });

    if (!pm) {
      const stripePaymentMethod = await stripe.paymentMethods.retrieve(paymentIntent.payment_method as string, {
        stripeAccount,
      });

      const stripeCustomer = stripePaymentMethod.customer
        ? typeof stripePaymentMethod.customer === 'string'
          ? stripePaymentMethod.customer
          : stripePaymentMethod.customer?.id
        : typeof paymentIntent.customer === 'string'
          ? paymentIntent.customer
          : paymentIntent.customer?.id;

      pm = await createPaymentMethod(
        {
          stripePaymentMethod,
          stripeAccount,
          stripeCustomer,
          originPaymentIntent: paymentIntent,
          CollectiveId: order.FromCollectiveId,
          CreatedByUserId: order.CreatedByUserId,
        },
        { transaction },
      );
    }

    await order.update(
      {
        status: OrderStatuses.PROCESSING,
        PaymentMethodId: pm.id,
        data: { ...order.data, paymentIntent },
      },
      { transaction },
    );

    sendEmailNotifications(order);
  });
}

async function handleExpensePaymentIntentProcessing(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  const stripeAccount = event.account ?? config.stripe.accountId;

  await sequelize.transaction(async transaction => {
    const expense = await models.Expense.findOne({
      where: {
        data: { paymentIntent: { id: paymentIntent.id } }, // TODO(henrique): add index
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
      include: [
        { association: 'collective', required: true },
        { association: 'fromCollective', required: true },
      ],
    });

    if (!expense) {
      reportMessageToSentry(`Stripe Webhook: Could not find Expense for Payment Intent ${paymentIntent.id}`, {
        extra: { event },
      });
      return;
    }

    let pm = await models.PaymentMethod.findOne({
      where: {
        data: {
          stripePaymentMethodId: paymentIntent.payment_method,
          stripeAccount,
        },
      },
      transaction,
    });

    if (!pm) {
      const stripePaymentMethod = await stripe.paymentMethods.retrieve(paymentIntent.payment_method as string, {
        stripeAccount,
      });

      const stripeCustomer = stripePaymentMethod.customer
        ? typeof stripePaymentMethod.customer === 'string'
          ? stripePaymentMethod.customer
          : stripePaymentMethod.customer?.id
        : typeof paymentIntent.customer === 'string'
          ? paymentIntent.customer
          : paymentIntent.customer?.id;

      pm = await createPaymentMethod(
        {
          stripePaymentMethod,
          stripeAccount,
          stripeCustomer,
          originPaymentIntent: paymentIntent,
          CollectiveId: expense.CollectiveId,
          CreatedByUserId: expense.lastEditedById,
        },
        { transaction },
      );
    }

    await expense.update(
      {
        status: ExpenseStatus.PROCESSING,
        feesPayer: 'PAYEE',
        PaymentMethodId: pm.id,
        data: { ...expense.data, paymentIntent },
      },
      { transaction },
    );
  });
}

export async function paymentIntentFailed(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  const target = await paymentIntentTarget(paymentIntent);

  switch (target) {
    case 'EXPENSE': {
      return handleExpensePaymentIntentFailed(event);
    }
    case 'ORDER':
    default: {
      return handleOrderPaymentIntentFailed(event);
    }
  }
}

const handleOrderPaymentIntentFailed = async (event: Stripe.Event) => {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const order = await models.Order.findOne({
    where: {
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'createdByUser', required: true },
    ],
  });

  if (!order) {
    logger.debug(`Stripe Webhook: Could not find Order for Payment Intent ${paymentIntent.id}`);
    return;
  }

  const charge = (paymentIntent as any).charges?.data?.[0] as Stripe.Charge;
  const reason = paymentIntent.last_payment_error?.message || charge?.failure_message || 'unknown';
  logger.info(`Stripe Webook: Payment Intent failed for Order #${order.id}. Reason: ${reason}`);

  await order.update({
    status: OrderStatuses.ERROR,
    data: { ...order.data, paymentIntent },
  });

  const userFriendlyError = userFriendlyErrorMessage({ message: reason }) || UNKNOWN_ERROR_MSG;

  sendOrderFailedEmail(order, userFriendlyError);
};

async function handleExpensePaymentIntentFailed(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;
  const expense = await models.Expense.findOne({
    where: {
      data: { paymentIntent: { id: paymentIntent.id } },
    },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
    ],
  });

  if (!expense) {
    reportMessageToSentry(`Stripe Webhook: Could not find Expense for Payment Intent ${paymentIntent.id}`, {
      extra: { event },
    });
    return;
  }

  const charge = (paymentIntent as any).charges?.data?.[0] as Stripe.Charge;
  const reason = paymentIntent.last_payment_error?.message || charge?.failure_message || 'unknown';
  logger.info(`Stripe Webook: Payment Intent failed for Expense #${expense.id}. Reason: ${reason}`);

  await expense.update({
    status: expense.status === ExpenseStatus.PROCESSING ? ExpenseStatus.ERROR : undefined,
    data: {
      ...omit(expense.data, 'paymentIntent'),
      previousPaymentIntents: [...(expense.data.previousPaymentIntents ?? []), paymentIntent],
    },
  });
}

export const chargeDisputeCreated = async (event: Stripe.Event) => {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: dispute.charge } } },
    include: [
      {
        model: models.Order,
        required: true,
        include: [
          { model: models.Subscription, required: false },
          {
            model: models.Collective,
            as: 'collective',
            include: [{ model: models.Collective, as: 'host', foreignKey: 'HostCollectiveId', required: true }],
          },
          { model: models.Collective, as: 'fromCollective' },
          models.Tier,
        ],
      },
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });

  if (!chargeTransaction) {
    return;
  }

  const user = chargeTransaction.createdByUser;

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: chargeTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  // Block User from creating any new Orders
  await user.limitFeature(FEATURE.ORDER, `Charge disputed for transaction #${chargeTransaction.id}`);

  await Promise.all(
    transactions.map(async transaction => {
      await transaction.update({ isDisputed: true });
      const order = transaction.Order;
      if (order.status !== OrderStatuses.DISPUTED) {
        await order.update({ status: OrderStatuses.DISPUTED });

        if (order.SubscriptionId) {
          await order.Subscription.deactivate();
        }
      }
    }),
  );

  const order = chargeTransaction.Order;
  await models.Activity.create({
    type: ActivityTypes.ORDER_DISPUTE_CREATED,
    CollectiveId: order.collective.id,
    FromCollectiveId: order.FromCollectiveId,
    OrderId: order.id,
    HostCollectiveId: order.collective.HostCollectiveId,
    data: {
      order: order.info,
      fromAccountInfo: order.data?.fromAccountInfo,
      fromCollective: order.fromCollective.info,
      host: order.collective.host?.info,
      toCollective: order.collective.info,
      tierName: order.Tier?.name,
      reason: dispute.reason,
      paymentProcessorUrl: getDashboardObjectIdURL(dispute.id, event.account),
      dispute,
    },
  });
};

// Charge dispute has been closed on Stripe (with status of: won/lost/closed)
export const chargeDisputeClosed = async (event: Stripe.Event) => {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeTransaction = await models.Transaction.findOne({
    where: { data: { charge: { id: dispute.charge } }, isDisputed: true, type: TransactionTypes.CREDIT },
    include: [
      {
        model: models.Order,
        required: true,
        include: [
          { model: models.Subscription, required: false },
          {
            model: models.Collective,
            as: 'collective',
            include: [{ model: models.Collective, as: 'host', foreignKey: 'HostCollectiveId', required: true }],
          },
          { model: models.Collective, as: 'fromCollective' },
          models.Tier,
        ],
      },
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });
  if (!chargeTransaction) {
    return;
  }

  const disputeTransaction = await models.Transaction.findOne({
    where: { data: { dispute: { id: dispute.id } } },
  });
  if (disputeTransaction) {
    logger.info(
      `Stripe Webhook: Dispute ${dispute.id} already processed in transaction #${disputeTransaction.id}. Skipping...`,
    );
    return;
  }

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: chargeTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  if (transactions.length > 0) {
    const order = chargeTransaction.Order;

    const disputeTransaction = dispute.balance_transactions.find(
      tx => tx.type === 'adjustment' && tx.reporting_category === 'dispute',
    );
    const clearedAt = disputeTransaction?.created && moment.unix(disputeTransaction.created).toDate();
    const refundTransactionGroup = uuid();
    // A lost dispute means it was decided as fraudulent
    if (dispute.status === 'lost') {
      if (order.status === OrderStatuses.DISPUTED) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.CANCELLED });
        } else {
          await order.update({ status: OrderStatuses.REFUNDED });
        }
      }

      const paymentMethod = await order.getPaymentMethod();
      if (paymentMethod?.type === PAYMENT_METHOD_TYPE.CREDITCARD) {
        await models.SuspendedAsset.suspendCreditCard(paymentMethod, `CreditCard was disputed in order ${order.id}`);
      }

      // Create refund transaction for the fraudulent charge
      if (!chargeTransaction.RefundTransactionId) {
        await createRefundTransaction(
          chargeTransaction,
          0,
          {
            ...chargeTransaction.data,
            dispute,
            refundTransactionId: chargeTransaction.id,
          },
          null,
          refundTransactionGroup,
          clearedAt,
          RefundKind.DISPUTE,
        );
      }
      // A won dispute means it was decided as not fraudulent
    } else if (dispute.status === 'won') {
      if (order.status === OrderStatuses.DISPUTED) {
        if (order.SubscriptionId) {
          // We should not resume the subscription because a dispute is a strong signal the user does not want to pay anymore
          await order.update({ status: OrderStatuses.CANCELLED });
        } else {
          await order.update({ status: OrderStatuses.PAID });
        }
      }
    }

    // Create transaction for dispute fee debiting the fiscal host
    const feeDetails = disputeTransaction?.fee_details?.find(feeDetails => feeDetails.description === 'Dispute fee');
    if (feeDetails) {
      const currency = feeDetails.currency.toUpperCase() as SupportedCurrency;
      if (!isSupportedCurrency(currency)) {
        reportMessageToSentry(`Unsupported currency ${currency} for dispute fee`, {
          extra: { dispute, chargeTransaction },
        });
      }

      const amount = Math.abs(feeDetails.amount);
      const fiscalHost = await models.Collective.findByPk(chargeTransaction.HostCollectiveId);
      const hostCurrencyFxRate = await getFxRate(currency, fiscalHost.currency);
      const vendor = await getPaymentProcessorFeeVendor(PAYMENT_METHOD_SERVICE.STRIPE);
      await models.Transaction.createDoubleEntry({
        type: 'CREDIT',
        HostCollectiveId: null,
        CollectiveId: vendor.id,
        FromCollectiveId: fiscalHost.id,
        OrderId: chargeTransaction.OrderId,
        TransactionGroup: refundTransactionGroup,
        amount: amount,
        netAmountInCollectiveCurrency: amount,
        amountInHostCurrency: amount,
        hostCurrency: currency,
        currency: currency,
        description: 'Stripe Transaction Dispute Fee',
        paymentProcessorFeeInHostCurrency: 0,
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        hostCurrencyFxRate,
        kind: TransactionKind.PAYMENT_PROCESSOR_DISPUTE_FEE,
        clearedAt,
        data: { dispute },
        refundKind: RefundKind.DISPUTE,
      });

      const user = chargeTransaction.createdByUser;
      const userHasDisputedOrders = await user.hasDisputedOrders();
      if (!userHasDisputedOrders) {
        await user.unlimitFeature(FEATURE.ORDER);
      }

      await Promise.all(
        transactions.map(async transaction => {
          await transaction.update({ isDisputed: false });
        }),
      );
    }

    await models.Activity.create({
      type: ActivityTypes.ORDER_DISPUTE_CLOSED,
      CollectiveId: order.collective.id,
      FromCollectiveId: order.FromCollectiveId,
      OrderId: order.id,
      HostCollectiveId: order.collective.HostCollectiveId,
      data: {
        order: order.info,
        fromAccountInfo: order.data?.fromAccountInfo,
        fromCollective: order.fromCollective.info,
        host: order.collective.host?.info,
        toCollective: order.collective.info,
        tierName: order.Tier?.name,
        reason: dispute.status,
        paymentProcessorUrl: getDashboardObjectIdURL(dispute.id, event.account),
        dispute,
      },
    });
  }
};

// Charge on Stripe had a fraud review opened
export const reviewOpened = async (event: Stripe.Event) => {
  const review = event.data.object as Stripe.Review;
  const paymentIntentTransaction = await models.Transaction.findOne({
    where: { data: { charge: { payment_intent: review.payment_intent } } },
    include: [
      {
        model: models.Order,
        required: true,
        include: [
          { model: models.Subscription, required: false },
          {
            model: models.Collective,
            as: 'collective',
            foreignKey: 'CollectiveId',
            include: [{ model: models.Collective, as: 'host', foreignKey: 'HostCollectiveId', required: false }],
          },
          { model: models.Collective, as: 'fromCollective', foreignKey: 'FromCollectiveId' },
          models.Tier,
        ],
      },
    ],
  });

  if (!paymentIntentTransaction) {
    return;
  }

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: paymentIntentTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  await Promise.all(
    transactions.map(async transaction => {
      await transaction.update({ isInReview: true });
      const order = transaction.Order;
      if (order.status !== OrderStatuses.IN_REVIEW) {
        await order.update({ status: OrderStatuses.IN_REVIEW });

        if (order.SubscriptionId) {
          await order.Subscription.deactivate();
        }
      }
    }),
  );

  const order = paymentIntentTransaction.Order;

  await models.Activity.create({
    type: ActivityTypes.ORDER_REVIEW_OPENED,
    CollectiveId: order.collective.id,
    FromCollectiveId: order.FromCollectiveId,
    OrderId: order.id,
    HostCollectiveId: order.collective.HostCollectiveId,
    data: {
      order: order.info,
      fromAccountInfo: order.data?.fromAccountInfo,
      fromCollective: order.fromCollective.info,
      host: order.collective.host?.info,
      toCollective: order.collective.info,
      tierName: order.Tier?.name,
      reason: review.opened_reason,
      paymentProcessorUrl: getDashboardObjectIdURL(
        typeof review.payment_intent === 'string' ? review.payment_intent : review.payment_intent.id,
        event.account,
      ),
    },
  });
};

// Charge on Stripe had a fraud review closed (either approved/refunded)
export const reviewClosed = async (event: Stripe.Event) => {
  const review = event.data.object as Stripe.Review;
  const stripePaymentIntentId = review.payment_intent;
  const closedReason = review.closed_reason;
  const clearedAt = event.created && moment.unix(event.created).toDate();

  const paymentIntentTransaction = await models.Transaction.findOne({
    where: { data: { charge: { payment_intent: stripePaymentIntentId } } },
    include: [
      {
        model: models.Order,
        required: true,
        include: [
          { model: models.Subscription, required: false },
          {
            model: models.Collective,
            as: 'collective',
            foreignKey: 'CollectiveId',
            include: [{ model: models.Collective, as: 'host', foreignKey: 'HostCollectiveId', required: false }],
          },
          { model: models.Collective, as: 'fromCollective', foreignKey: 'FromCollectiveId' },
          models.Tier,
        ],
      },
      {
        model: models.User,
        required: true,
        as: 'createdByUser',
      },
    ],
  });

  if (!paymentIntentTransaction) {
    return;
  }

  const user = paymentIntentTransaction.createdByUser;

  const transactions = await models.Transaction.findAll({
    where: {
      TransactionGroup: paymentIntentTransaction.TransactionGroup,
    },
    include: {
      model: models.Order,
      required: true,
      include: [models.Subscription],
    },
  });

  if (transactions.length > 0) {
    const order = paymentIntentTransaction.Order;

    // closedReasons: approved, refunded, refunded_as_fraud, disputed, redacted
    if (closedReason === 'refunded_as_fraud' || closedReason === 'refunded') {
      if (order.status === OrderStatuses.IN_REVIEW) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.CANCELLED, data: { ...order.data, closedReason } });
        } else {
          await order.update({ status: OrderStatuses.REFUNDED, data: { ...order.data, closedReason } });
        }
      }

      // Create refund transaction for the fraudulent charge
      const transactionGroup = uuid();
      await createRefundTransaction(
        paymentIntentTransaction,
        0,
        {
          ...paymentIntentTransaction.data,
          review: event,
          refundTransactionId: paymentIntentTransaction.id,
        },
        null,
        transactionGroup,
        clearedAt,
      );

      // charge review was determined to be fraudulent
      if (closedReason === 'refunded_as_fraud') {
        await user.limitFeature(
          FEATURE.ORDER,
          `Transactions for group #${paymentIntentTransaction.TransactionGroup} refunded as fraud`,
        );
      } else if (closedReason === 'refunded') {
        await Promise.all(
          transactions.map(async transaction => {
            await transaction.update({ isInReview: false });
          }),
        );
      }
    } else {
      if (order.status === OrderStatuses.IN_REVIEW) {
        if (order.SubscriptionId) {
          await order.update({ status: OrderStatuses.ACTIVE });
          await order.Subscription.activate();
        } else {
          await order.update({ status: OrderStatuses.PAID });
        }
      }

      await Promise.all(
        transactions.map(async transaction => {
          await transaction.update({ isInReview: false });
        }),
      );
    }

    await models.Activity.create({
      type: ActivityTypes.ORDER_REVIEW_CLOSED,
      CollectiveId: order.collective.id,
      FromCollectiveId: order.FromCollectiveId,
      OrderId: order.id,
      HostCollectiveId: order.collective.HostCollectiveId,
      data: {
        order: order.info,
        fromAccountInfo: order.data?.fromAccountInfo,
        fromCollective: order.fromCollective.info,
        host: order.collective.host?.info,
        toCollective: order.collective.info,
        tierName: order.Tier?.name,
        reason: review.closed_reason,
        paymentProcessorUrl: getDashboardObjectIdURL(
          typeof review.payment_intent === 'string' ? review.payment_intent : review.payment_intent.id,
          event.account,
        ),
      },
    });
  }
};

export async function paymentMethodAttached(event: Stripe.Event) {
  const stripePaymentMethod = event.data.object as Stripe.PaymentMethod;

  if (!['us_bank_account', 'sepa_debit', 'bacs_debit'].includes(stripePaymentMethod.type)) {
    return;
  }

  const stripeAccount = event.account ?? config.stripe.accountId;

  const stripeCustomerId =
    typeof stripePaymentMethod.customer === 'string' ? stripePaymentMethod.customer : stripePaymentMethod.customer?.id;

  await sequelize.transaction(async transaction => {
    const stripeCustomerAccount = await models.ConnectedAccount.findOne({
      where: {
        clientId: stripeAccount,
        username: stripeCustomerId,
        service: Service.STRIPE_CUSTOMER,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!stripeCustomerAccount) {
      return;
    }

    const pm = await models.PaymentMethod.findOne({
      where: {
        data: {
          stripePaymentMethodId: stripePaymentMethod.id,
          stripeAccount,
        },
      },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });

    if (pm) {
      await pm.update(
        {
          customerId: stripeCustomerId,
          CollectiveId: stripeCustomerAccount.CollectiveId,
        },
        {
          transaction,
        },
      );
      return;
    }

    await createPaymentMethod(
      {
        stripeAccount,
        stripeCustomer: stripeCustomerId,
        stripePaymentMethod,
        attachedToCustomer: true,
        CollectiveId: stripeCustomerAccount.CollectiveId,
      },
      {
        transaction,
      },
    );
  });
}

/*
 * Stripe issuing events are currently using account webhooks, meaning
 * that each host with virtual card enabled has an account webhook setup to this endpoint.
 * To validate the webhook we first get the virtual card and associated host.
 * This will be deprecated and unified when these events are migrated to the connect webhook.
 */
async function handleIssuingWebhooks(request: Request<unknown, Stripe.Event>) {
  const event = <Stripe.Event>request.body;

  let virtualCardId;
  if (event.type.startsWith('issuing_authorization')) {
    virtualCardId = (<Stripe.Issuing.Authorization>event.data.object).card.id;
  } else if (event.type.startsWith('issuing_transaction')) {
    const transaction = <Stripe.Issuing.Transaction>event.data.object;
    virtualCardId = get(transaction, 'transaction.card.id', transaction?.card);
  } else if (event.type.startsWith('issuing_card')) {
    virtualCardId = (<Stripe.Issuing.Card>event.data.object).id;
  } else {
    logger.debug(`Stripe: Webhooks: Received an unsupported issuing event type: ${event.type}`);
    return;
  }

  if (!virtualCardId) {
    throw new Error('virtual card id not set in webhook event');
  }

  const virtualCard = await getVirtualCardForTransaction(virtualCardId);
  if (!virtualCard) {
    logger.debug(`Stripe: Webhooks: Received an event for a virtual card that does not exist: ${virtualCardId}`);
    return;
  }

  const stripeClient = await virtualcard.getStripeClient(virtualCard.host);
  const webhookSigningSecret = await virtualcard.getWebhookSigninSecret(virtualCard.host);

  try {
    stripeClient.webhooks.constructEvent(request.rawBody, request.headers['stripe-signature'], webhookSigningSecret);
  } catch {
    throw new Error('Source of event not recognized');
  }

  switch (event.type) {
    case 'issuing_authorization.request':
      return virtualcard.processAuthorization(event);
    case 'issuing_authorization.created':
      if (!(<Stripe.Issuing.Authorization>event.data.object).approved) {
        return virtualcard.processDeclinedAuthorization(event);
      }
      return;
    case 'issuing_authorization.updated':
      return virtualcard.processUpdatedTransaction(event);
    case 'issuing_transaction.created':
      return virtualcard.processTransaction(<Stripe.Issuing.Transaction>event.data.object);
    case 'issuing_card.updated':
      return virtualcard.processCardUpdate(event);
    default:
      logger.debug(`Stripe: Webhooks: Received an unsupported issuing event type: ${event.type}`);
      return;
  }
}

export const webhook = async (request: Request<unknown, Stripe.Event>) => {
  debug(`Stripe webhook event received : ${request.rawBody}`);

  let event = <Stripe.Event>request.body;

  // Stripe sends test events to production as well
  // don't do anything if the event is not livemode
  // NOTE: not using config.env because of ugly tests
  if (process.env.OC_ENV === 'production' && !event.livemode) {
    return Promise.resolve();
  }

  if (event.type.startsWith('issuing')) {
    return handleIssuingWebhooks(request);
  }

  try {
    event = stripe.webhooks.constructEvent(
      request.rawBody,
      request.headers['stripe-signature'],
      config.stripe.webhookSigningSecret,
    );
  } catch {
    throw new Error('Source of event not recognized');
  }

  switch (event.type) {
    case 'charge.dispute.created':
      return chargeDisputeCreated(event);
    // Charge dispute has been closed on Stripe (with status of: won/lost/closed)
    case 'charge.dispute.closed':
      return chargeDisputeClosed(event);
    case 'review.opened':
      return reviewOpened(event);
    case 'review.closed':
      return reviewClosed(event);
    case 'payment_intent.succeeded':
      return paymentIntentSucceeded(event);
    case 'payment_intent.processing':
      return paymentIntentProcessing(event);
    case 'payment_intent.payment_failed':
      return paymentIntentFailed(event);
    case 'payment_method.attached':
      return paymentMethodAttached(event);
    case 'mandate.updated':
      return mandateUpdated(event);
    default:
      // console.log(JSON.stringify(event, null, 4));
      logger.debug(`Stripe: Webhooks: Received an unsupported event type: ${event.type}`);
      return;
  }
};
