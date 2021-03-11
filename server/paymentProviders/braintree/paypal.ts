import logger from '../../lib/logger';
import models from '../../models';
import { PaymentProviderService } from '../types';

import * as BraintreeGateway from './gateway';
import { createTransactionsPairFromBraintreeTransaction } from './helpers';

const PayPal: PaymentProviderService = {
  features: {
    recurring: true,
  },

  async processOrder(order: typeof models.Order): Promise<typeof models.Transaction> {
    order.collective = order.collective || (await order.getCollective());
    const gateway = await BraintreeGateway.getBraintreeGatewayForCollective(order.collective);

    // Register the customer. Will also take care of converting a payment nonce to a payment token
    await BraintreeGateway.getOrCreateCustomerForOrder(gateway, order);
    const braintreeTransaction = await (order.interval
      ? BraintreeGateway.callCreateSubscription(gateway, order)
      : BraintreeGateway.callTransactionSale(gateway, order, true));

    try {
      return createTransactionsPairFromBraintreeTransaction(order, braintreeTransaction);
    } catch (e) {
      logger.error(`Failed to create transactions from Braintree payload`);
      logger.error(e);
      throw new Error(`Failed to process order #${order.id}, please try again later or use a different payment method`);
    }
  },
};

export default PayPal;
