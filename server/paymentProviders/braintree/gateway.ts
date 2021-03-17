import braintree from 'braintree';
import config from 'config';

import { Service } from '../../constants/connected_account';
import INTERVALS from '../../constants/intervals';
import logger from '../../lib/logger';
import models from '../../models';

import { getCustomerIdFromCollective } from './helpers';

const MONTHLY_PLAN_ID = 'monthly';
const YEARLY_PLAN_ID = 'yearly';
const DEFAULT_PAYMENT_ERROR_MSG = 'Payment failed, please try again later or use a different payment method';

const getBraintreeEnv = (): braintree.Environment => {
  switch (config.env) {
    case 'production':
      return braintree.Environment.Production;
    default:
      return braintree.Environment.Sandbox;
  }
};

export const getBraintreeGatewayForHost = async (hostId: number): Promise<braintree.BraintreeGateway> => {
  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { CollectiveId: hostId, service: Service.BRAINTREE },
  });

  if (!connectedAccount) {
    throw new Error('This host does not support Braintree payments yet');
  }

  return new braintree.BraintreeGateway({
    environment: getBraintreeEnv(),
    merchantId: connectedAccount.username,
    publicKey: connectedAccount.data.publicKey,
    privateKey: connectedAccount.token,
  });
};

export const getBraintreeGatewayForCollective = async (
  collective: typeof models.Collective,
): Promise<braintree.BraintreeGateway> => {
  if (!collective?.HostCollectiveId || !collective?.approvedAt) {
    throw new Error('Cannot use Braintree without a fiscal host');
  } else {
    return getBraintreeGatewayForHost(collective.HostCollectiveId);
  }
};

const findCustomer = (gateway: braintree.BraintreeGateway, customerId: string): Promise<braintree.Customer> => {
  return gateway.customer.find(customerId);
};

const updateCustomer = async (gateway: braintree.BraintreeGateway, customerId: string, nonce: string) => {
  const response = await gateway.customer.update(customerId, { paymentMethodNonce: nonce });

  if (!response.success) {
    logger.error(`Failed to update Braintree customer ${customerId}: ${response.message}`);
    throw new Error(DEFAULT_PAYMENT_ERROR_MSG);
  }

  return response.customer;
};

const createBraintreeCustomer = async (
  gateway: braintree.BraintreeGateway,
  account: typeof models.Collective,
  paymentNonce: string,
): Promise<braintree.Customer> => {
  const user = await account.getUser();
  const [firstName, ...lastName] = account.name.split(' ');
  const response = await gateway.customer.create({
    firstName: firstName,
    lastName: lastName.join(' '),
    paymentMethodNonce: paymentNonce,
    website: account.website,
    email: user?.email,
    customFields: {
      collective: account.slug,
      collectiveId: account.id,
    },
  });

  if (!response.success) {
    logger.error(`Failed to create Braintree customer for ${account.slug}: ${response.message}`);
    throw new Error(DEFAULT_PAYMENT_ERROR_MSG);
  }

  return response.customer;
};

export const getOrCreateCustomerForOrder = async (
  gateway: braintree.BraintreeGateway,
  order: typeof models.Order,
): Promise<braintree.Customer> => {
  const fromCollective = order.fromCollective || (await order.getFromCollective());
  const paymentMethod = await models.PaymentMethod.findByPk(order.PaymentMethodId);
  const customerId = await getCustomerIdFromCollective(fromCollective);
  let customer = customerId && (await findCustomer(gateway, customerId));

  if (paymentMethod.data?.isNonce) {
    const nonce = paymentMethod.token;
    if (customer) {
      customer = await updateCustomer(gateway, customerId, nonce);
    } else {
      customer = await createBraintreeCustomer(gateway, fromCollective, nonce);
    }

    const token = customer.paymentMethods[0].token;
    order.paymentMethod = await paymentMethod.update({
      token,
      data: { ...paymentMethod.data, isNonce: false, customerId: customer.id },
    });
  }

  return customer;
};

export const callTransactionSale = async (
  gateway: braintree.BraintreeGateway,
  order: typeof models.Order,
  isClientInitiated: boolean,
): Promise<braintree.Transaction> => {
  const response = await gateway.transaction.sale({
    amount: (order.totalAmount / 100).toString(),
    paymentMethodToken: order.paymentMethod.token,
    deviceData: isClientInitiated ? order.paymentMethod.data?.deviceData : undefined,
    transactionSource: order.interval ? 'recurring_first' : undefined,
    customFields: {
      collective: order.collective.slug,
      collectiveId: order.collective.id,
      order: order.id,
    },
    options: {
      submitForSettlement: true,
    },
  });

  if (!response.success) {
    // TODO Handle errors
    throw new Error(response.message);
  }

  return response.transaction;
};

export const callCreateSubscription = async (
  gateway: braintree.BraintreeGateway,
  order: typeof models.Order,
): Promise<braintree.Transaction> => {
  const result = await gateway.subscription.create({
    paymentMethodToken: order.paymentMethod.token,
    planId: order.interval === INTERVALS.MONTH ? MONTHLY_PLAN_ID : YEARLY_PLAN_ID,
    neverExpires: true,
    price: (order.totalAmount / 100).toString(),
    options: {
      startImmediately: true,
      paypal: {
        description: order.description,
      },
    },
  });

  if (!result.success) {
    logger.error(`Failed to create subscription on Braintree: ${result.message}`);
    logger.error(result);
    throw new Error(`Failed to create subscription for order #${order.id}`);
  } else {
    const subscriptionId = result.subscription.id;
    const braintreeData = { ...(order.data?.braintree || {}), subscriptionId };
    await order.update({ data: { ...order.data, braintree: braintreeData } });
    return result.subscription.transactions[0];
  }
};

export const generateBraintreeTokenForClient = async (
  gateway: braintree.BraintreeGateway,
  fromCollective: typeof models.Collective | null = null,
): Promise<string> => {
  const customerId = fromCollective && (await getCustomerIdFromCollective(fromCollective));
  const response = await gateway.clientToken.generate({ customerId });
  if (!response.success) {
    logger.error(`Failed to generate Braintree token for customer ${customerId || ''}: ${response.message}`);
    throw new Error('Failed to generate Braintree token');
  } else {
    return response.clientToken;
  }
};
