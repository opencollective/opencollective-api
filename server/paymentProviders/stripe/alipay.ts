/* eslint-disable camelcase */
import querystring from 'querystring';

import config from 'config';
import debugLib from 'debug';
import { NextFunction, Request, Response } from 'express';

import OrderStatus from '../../constants/order_status';
import { TransactionTypes } from '../../constants/transactions';
import { idDecode, IDENTIFIER_TYPES } from '../../graphql/v2/identifiers';
import logger from '../../lib/logger';
import {
  createRefundTransaction,
  getHostFee,
  getHostFeeSharePercent,
  getPlatformTip,
  isPlatformTipEligible,
} from '../../lib/payments';
import { reportErrorToSentry } from '../../lib/sentry';
import stripe, { convertFromStripeAmount, convertToStripeAmount, extractFees } from '../../lib/stripe';
import models from '../../models';

import { refundTransaction } from './common';

const debug = debugLib('alipay');

const compatibleCurrencies = ['cny', 'aud', 'cad', 'eur', 'gbp', 'hkd', 'jpy', 'myr', 'nzd', 'sgd', 'usd'];

const processOrder = async (order: typeof models.Order): Promise<void> => {
  const hostStripeAccount = await order.collective.getHostStripeAccount();
  if (!hostStripeAccount) {
    throw new Error('Host is not connected to Stripe');
  }
  if (!compatibleCurrencies.includes(order.currency.toLowerCase())) {
    throw new Error(`We can not pay with Alipay in ${order.currency} currency`);
  }

  let intent;
  if (!order.data?.paymentIntent) {
    debug(`creating intent for order ${order.id}`);
    intent = await stripe.paymentIntents.create(
      {
        payment_method_types: ['alipay'],
        amount: convertToStripeAmount(order.currency, order.totalAmount),
        currency: order.currency,
      },
      {
        stripeAccount: hostStripeAccount.username,
      },
    );
    await order.update({ data: { ...order.data, paymentIntent: { id: intent.id, status: intent.status } } });
  } else {
    debug(`intent for order ${order.id} already exists, fetching it from stripe`);
    intent = await stripe.paymentIntents.retrieve(order.data.paymentIntent.id, {
      stripeAccount: hostStripeAccount.username,
    });
  }

  const paymentIntentError = new Error('Payment Intent require action');
  paymentIntentError['stripeAccount'] = hostStripeAccount.username;
  paymentIntentError['stripeResponse'] = { paymentIntent: intent };
  throw paymentIntentError;
};

const confirmOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  debug('confirm order', req.query);
  try {
    const { OrderId, payment_intent, redirect_status } = req.query;
    if (redirect_status === 'succeeded') {
      const order = await models.Order.findByPk(idDecode(OrderId, IDENTIFIER_TYPES.ORDER), {
        include: [
          { model: models.Collective, as: 'collective' },
          { model: models.Collective, as: 'fromCollective' },
          { model: models.PaymentMethod, as: 'paymentMethod' },
          { model: models.Subscription, as: 'Subscription' },
          { association: 'createdByUser' },
        ],
      });
      if (order.data.paymentIntent.id !== payment_intent) {
        logger.warn('User tried to confirm different AliPay order than the one requested', req.query);
        res.sendStatus(401);
        return;
      }
      if (order.status !== OrderStatus.REQUIRE_CLIENT_CONFIRMATION) {
        logger.warn(
          `Trying to confirm Alipay order but order status is not waiting for client confirmation: #${order.id}`,
        );
        res.sendStatus(200);
        return;
      }
      debug(`confirming order ${order.id}`);
      const host = await order.collective.getHostCollective();
      const hostStripeAccount = await order.collective.getHostStripeAccount();
      const hostFeeSharePercent = await getHostFeeSharePercent(order, host);
      const isSharedRevenue = !!hostFeeSharePercent;

      const intent = await stripe.paymentIntents.retrieve(payment_intent, {
        stripeAccount: hostStripeAccount.username,
      });

      const charge = intent.charges.data[0];

      const balanceTransaction = await stripe.balanceTransactions.retrieve(charge.balance_transaction, {
        stripeAccount: hostStripeAccount.username,
      });

      // Create a Transaction
      const amount = order.totalAmount;
      const currency = order.currency;
      const hostCurrency = balanceTransaction.currency.toUpperCase();
      const amountInHostCurrency = convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount);
      const hostCurrencyFxRate = amountInHostCurrency / amount;

      const hostFee = await getHostFee(order, host);
      const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

      const platformTipEligible = await isPlatformTipEligible(order, host);
      const platformTip = getPlatformTip(order);
      const platformTipInHostCurrency = Math.round(platformTip * hostCurrencyFxRate);

      const fees = extractFees(balanceTransaction, balanceTransaction.currency);
      const paymentProcessorFeeInHostCurrency = fees.stripeFee;

      const data = {
        charge,
        balanceTransaction,
        hasPlatformTip: platformTip ? true : false,
        isSharedRevenue,
        platformTipEligible,
        platformTip,
        platformTipInHostCurrency,
        hostFeeSharePercent,
        tax: order.data?.tax,
      };

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
        amountInHostCurrency,
        hostCurrencyFxRate,
        paymentProcessorFeeInHostCurrency,
        taxAmount: order.taxAmount,
        description: order.description,
        hostFeeInHostCurrency,
        data,
      };

      await models.Transaction.createFromContributionPayload(transactionPayload);
      await order.update({ status: 'PAID', data: { ...order.data, paymentIntent: intent } });

      res.redirect(`${config.host.website}/${order.collective.slug}/donate/success?OrderId=${OrderId}`);
    } else if (redirect_status === 'failed') {
      const id = idDecode(OrderId, IDENTIFIER_TYPES.ORDER);
      debug(`payment for order ${id} failed, deleting order`);
      const order = await models.Order.findByPk(id, {
        include: [{ model: models.Collective, as: 'collective' }],
      });
      if (order) {
        const hostStripeAccount = await order.collective.getHostStripeAccount();
        const intent = await stripe.paymentIntents.retrieve(payment_intent, {
          stripeAccount: hostStripeAccount.username,
        });
        await order.update({ status: OrderStatus.ERROR, data: { ...order.data, paymentIntent: intent } });
        res.redirect(
          `${config.host.website}/${order.collective.slug}/donate?${querystring.stringify({
            error: "Couldn't approve Alipay payment, please try again.",
          })}`,
        );
      } else {
        next(new Error('Could not find the requested orded.'));
      }
    }
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e);
    next(e);
  }
};

const webhook = async (_, event) => {
  if (event.type === 'charge.refund.updated') {
    const refund = event.data.object;
    if (refund.status === 'succeeded') {
      const transaction = await models.Transaction.findOne({
        where: { type: 'CREDIT', isRefund: false, data: { charge: { id: refund.charge } } },
        include: [
          { model: models.Collective, as: 'collective' },
          { model: models.PaymentMethod, required: true, where: { type: 'alipay' } },
        ],
      });
      if (!transaction) {
        logger.warn(`Could not find transaction for charge.refund.updated event`, event);
        return;
      } else if (transaction.RefundTransactionId) {
        logger.warn(`Transaction was already refunded, charge.refund.updated ignoring event`, event);
        return;
      }

      const hostStripeAccount = await transaction.collective.getHostStripeAccount();
      const refundBalance = await stripe.balanceTransactions.retrieve(refund.balance_transaction, {
        stripeAccount: hostStripeAccount.username,
      });
      const charge = transaction.data.charge;
      const fees = extractFees(refundBalance, refundBalance.currency);

      await transaction.update({ data: { ...transaction.data, refund } });

      /* Create negative transactions for the received transaction */
      return await createRefundTransaction(
        transaction,
        fees.stripeFee,
        { ...transaction.data, charge, refund, balanceTransaction: refundBalance },
        undefined,
      );
    }
  }
  return 'OK';
};

export default {
  features: {
    recurring: false,
    waitToCharge: false,
  },
  webhook,
  processOrder,
  confirmOrder,
  refundTransaction: (transaction, user) => {
    return refundTransaction(transaction, user, { checkRefundStatus: true });
  },
};
