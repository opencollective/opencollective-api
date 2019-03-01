import { pick, result } from 'lodash';
import config from 'config';

import models from '../../models';
import * as constants from '../../constants/transactions';
import status from '../../constants/order_status';
import * as stripeGateway from './gateway';
import * as paymentsLib from '../../lib/payments';

export default {
  features: {
    recurring: true,
    waitToCharge: false,
  },

  async processOrder(order) {
    const { fromCollective, collective, paymentMethod } = order;

    const user = order.createdByUser;
    /**
     * Get or create a customer under the platform stripe account
     */
    const getOrCreateCustomerOnPlatformAccount = async () => {
      if (!paymentMethod.customerId) {
        const customer = await stripeGateway.createCustomer(null, paymentMethod.token, {
          email: user.email,
          collective: order.fromCollective.info,
        });
        await paymentMethod.update({ customerId: customer.id });
      }
      return Promise.resolve();
    };

    /**
     * Get the customerId for the Stripe Account of the Host
     * Or create one using the Stripe token associated with the platform (paymentMethod.token)
     * and saves it under PaymentMethod.data[hostStripeAccount.username]
     * @param {*} hostStripeAccount
     */
    const getOrCreateCustomerIdForHost = async hostStripeAccount => {
      // Customers pre-migration will have their stripe user connected
      // to the platform stripe account, not to the host's stripe
      // account. Since payment methods had no name before that
      // migration, we're using it to test for pre-migration users;
      if (!paymentMethod.name) return paymentMethod.customerId;

      const data = paymentMethod.data || {};
      data.customerIdForHost = data.customerIdForHost || {};
      if (data.customerIdForHost[hostStripeAccount.username]) {
        return data.customerIdForHost[hostStripeAccount.username];
      } else {
        const token = await stripeGateway.createToken(hostStripeAccount, paymentMethod.customerId);
        return token.id;
      }
    };

    /**
     * Returns a Promise with the transaction created
     * Note: we need to create a token for hostStripeAccount because paymentMethod.customerId is a customer of the platform
     * See: Shared Customers: https://stripe.com/docs/connect/shared-customers
     */
    const createCharge = (hostStripeAccount, hostStripeCustomerId) => {
      const { createdByUser: user, paymentMethod } = order;
      const platformFee = isNaN(order.platformFee)
        ? parseInt((order.totalAmount * constants.OC_FEE_PERCENT) / 100, 10)
        : order.platformFee;
      return stripeGateway.createCharge(hostStripeAccount, {
        amount: order.totalAmount,
        currency: order.currency,
        customer: hostStripeCustomerId,
        description: order.description,
        application_fee: platformFee,
        metadata: {
          OrderId: order.id,
          from: `${config.host.website}/${order.fromCollective.slug}`,
          to: `${config.host.website}/${order.collective.slug}`,
          customerEmail: user.email,
          PaymentMethodId: paymentMethod.id,
        },
      });
    };

    const hostStripeAccount = await collective.getHostStripeAccount();
    await getOrCreateCustomerOnPlatformAccount();
    const hostStripeCustomerId = await getOrCreateCustomerIdForHost(hostStripeAccount);
    await createCharge(hostStripeAccount, hostStripeCustomerId);
    await paymentMethod.update({ confirmedAt: new Date() });

    // TODO Send SEPA debit charge created notification email.
  },

  /** Refund a given transaction that was already refunded
   * in stripe but not in our database
   */
  async refundTransactionOnlyInDatabase(transaction, user) {
    /* What's going to be refunded */
    const chargeId = result(transaction.data, 'charge.id');

    /* From which stripe account it's going to be refunded */
    const collective = await models.Collective.findByPk(
      transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
    );
    const hostStripeAccount = await collective.getHostStripeAccount();

    /* Refund both charge & application fee */
    const { charge, refund } = await stripeGateway.retrieveChargeWithRefund(hostStripeAccount, chargeId);
    if (!refund) {
      throw new Error('No refunds found in stripe.');
    }
    const refundBalance = await stripeGateway.retrieveBalanceTransaction(hostStripeAccount, refund.balance_transaction);
    const fees = stripeGateway.extractFees(refundBalance);

    /* Create negative transactions for the received transaction */
    const refundTransaction = await paymentsLib.createRefundTransaction(
      transaction,
      fees.stripeFee,
      {
        refund,
        balanceTransaction: refundBalance,
      },
      user,
    );

    /* Associate RefundTransactionId to all the transactions created */
    return paymentsLib.associateTransactionRefundId(transaction, refundTransaction, {
      ...transaction.data,
      charge,
    });
  },

  webhook: {
    async chargeSucceded(requestBody, event) {
      const charge = event.data.object;
      const order = await models.Order.findByPk(charge.metadata.OrderId).then(order => order.populate());

      const hostStripeAccount = await order.Collective.getHostStripeAccount();
      const balanceTransaction = await stripeGateway.retrieveBalanceTransaction(
        hostStripeAccount,
        charge.balance_transaction,
      );

      const fees = stripeGateway.extractFees(balanceTransaction);
      const hostFeeInHostCurrency = paymentsLib.calcFee(balanceTransaction.amount, order.Collective.hostFeePercent);
      const payload = pick(order, ['CreatedByUserId', 'FromCollectiveId', 'CollectiveId', 'PaymentMethodId']);
      payload.transaction = {
        type: constants.TransactionTypes.CREDIT,
        OrderId: order.id,
        amount: order.totalAmount,
        currency: order.currency,
        hostCurrency: balanceTransaction.currency,
        amountInHostCurrency: balanceTransaction.amount,
        hostCurrencyFxRate: balanceTransaction.amount / order.totalAmount,
        hostFeeInHostCurrency,
        platformFeeInHostCurrency: fees.applicationFee,
        paymentProcessorFeeInHostCurrency: fees.stripeFee,
        description: order.description,
        data: { charge, balanceTransaction },
      };
      await models.Transaction.createFromPayload(payload);
      await order.update({ status: status.PAID });
      // TODO Send thankyou email.
    },

    async chargeFailed(requestBody, event) {
      const charge = event.data.object;
      const order = await models.Order.findByPk(charge.metadata.OrderId).then(order => order.populate());

      await order.update({ status: status.REJECTED });
      // TODO Send payment.failed email.
    },
  },
};
