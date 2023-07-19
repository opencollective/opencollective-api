import crypto from 'crypto';

import config from 'config';
import { pick } from 'lodash-es';
import fetch from 'node-fetch';

import orderStatus from '../../constants/order_status.js';
import { TransactionTypes } from '../../constants/transactions.js';
import { getFxRate } from '../../lib/currency.js';
import logger from '../../lib/logger.js';
import { getHostFee, getHostFeeSharePercent } from '../../lib/payments.js';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry.js';
import models from '../../models/index.js';

const AES_ENCRYPTION_KEY = config.thegivingblock.aesEncryptionKey;
const AES_ENCRYPTION_IV = config.thegivingblock.aesEncryptionIv;
const AES_ENCRYPTION_METHOD = config.thegivingblock.aesEncryptionMethod;
const API_URL = config.thegivingblock.apiUrl;
const USERNAME = config.thegivingblock.username;
const PASSWORD = config.thegivingblock.password;
const GENERIC_ERROR_MSG = 'Something went wrong, please contact support@opencollective.com.';

async function apiRequest(path, options = {}, account) {
  const response = await fetch(`${API_URL}${path}`, options);
  const result = await response.json();

  return await handleErrorsAndRetry(result, path, options, account);
  // console.log(result);
}

/*
 * Whenever and api request is made we check if access token is expired and if so we login again.
 * Refer: https://the-giving-block.gitbook.io/public-api-documentation/#authentication-flow.
 * Access tokens are only valid for 2 hours.
 */
async function handleErrorsAndRetry(result, path, options = {}, account = null) {
  if (result.data.errorMessage) {
    if (result.data.meta.errorCode === 'INVALID_JWT_TOKEN' && account) {
      logger.debug('Access token is invalid. Requesting a new one.');
      try {
        await login(USERNAME, PASSWORD, account);
        if (options.body?.get('refreshToken')) {
          options.body.set('refreshToken', account.data.refreshToken);
        }
        if (options.headers?.Authorization) {
          options.headers.Authorization = `Bearer ${account.data.accessToken}`;
        }
        const response = await fetch(`${API_URL}${path}`, options);
        const result = await response.json();
        if (result.data.errorMessage) {
          throw new Error(`The Giving Block: ${result.data.errorMessage} ${result.data.meta.errorCode}`);
        }
        return result.data;
      } catch (err) {
        logger.error(err.message);
        reportErrorToSentry(err);
        throw new Error(GENERIC_ERROR_MSG);
      }
    }
    logger.error(`The Giving Block: ${result.data.errorMessage} ${result.data.meta.errorCode}`);
    reportMessageToSentry(`The Giving Block: ${result.data.errorMessage}`, { extra: result.data });
    throw new Error(GENERIC_ERROR_MSG);
  }
  return result.data;
}

export async function login(login, password, account) {
  const body = new URLSearchParams();
  body.set('login', login);
  body.set('password', password);

  const { accessToken, refreshToken } = await apiRequest(`/login`, { method: 'POST', body });
  return account.update({ data: { ...account.data, accessToken, refreshToken } });
}

export async function refresh(account) {
  const body = new URLSearchParams();
  body.set('refreshToken', account.data.refreshToken);

  const { accessToken, refreshToken } = await apiRequest(`/refresh-tokens`, { method: 'POST', body }, account);
  return account.update({ data: { ...account.data, accessToken, refreshToken } });
}

export async function getOrganizationsList(account) {
  const headers = {
    Authorization: `Bearer ${account.data.accessToken}`,
  };

  return apiRequest(`/organizations/list`, { headers }, account);
}

/*
 * Gets the list of currencies that The Giving Block supports
 */
export async function getCurrenciesList(account) {
  const headers = {
    Authorization: `Bearer ${account.data.accessToken}`,
  };

  return apiRequest(`/currencies/list`, { method: 'POST', headers }, account);
}

export async function createDepositAddress(account, { organizationId, pledgeAmount, pledgeCurrency } = {}) {
  const headers = {
    Authorization: `Bearer ${account.data.accessToken}`,
  };

  const body = new URLSearchParams();
  body.set('isAnonymous', true);
  body.set('organizationId', organizationId);
  body.set('pledgeAmount', pledgeAmount);
  body.set('pledgeCurrency', pledgeCurrency);

  return apiRequest(`/deposit-address`, { method: 'POST', body, headers }, account);
}

export const processOrder = async order => {
  const host = await order.collective.getHostCollective();

  // retrieve current credentials
  const account = await models.ConnectedAccount.findOne({
    where: { CollectiveId: host.id, service: 'thegivingblock' },
  });

  // refresh credentials
  // TODO: we normally have to do it only every 2 hours but this handy for now
  await refresh(account);

  // create wallet address
  const { depositAddress, pledgeId } = await createDepositAddress(account, {
    organizationId: account.data.organizationId,
    pledgeAmount: order.data.thegivingblock.pledgeAmount,
    pledgeCurrency: order.data.thegivingblock.pledgeCurrency,
  });

  // update payment method
  // TODO: update name?
  // TODO: update currency?
  await order.paymentMethod.update({ data: { ...order.paymentMethod.data, depositAddress } });

  // Update order with pledgeId and status
  await order.update({ data: { ...order.data, pledgeId }, status: orderStatus.PENDING });

  // update approximate amount in order currency
  let cryptoFxRate;
  try {
    cryptoFxRate = await getFxRate(order.data.thegivingblock.pledgeCurrency, order.currency);
  } catch (e) {
    console.log(e);
  }
  if (cryptoFxRate) {
    const totalAmount = Math.round(order.data.thegivingblock.pledgeAmount * cryptoFxRate * 100);
    await order.update({ totalAmount });
  }
};

export const confirmOrder = async order => {
  order.collective = order.collective || (await models.Collective.findByPk(order.CollectiveId));
  order.paymentMethod = order.paymentMethod || (await models.PaymentMethod.findByPk(order.PaymentMethodId));

  const host = await order.collective.getHostCollective();

  const hostFeeSharePercent = await getHostFeeSharePercent(order, { host });
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(order.currency, hostCurrency);
  const amountInHostCurrency = Math.round(order.totalAmount * hostCurrencyFxRate);

  const hostFee = await getHostFee(order, { host });
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const platformTipEligible = false;
  const platformTip = 0;
  const platformTipInHostCurrency = 0;

  const paymentProcessorFee =
    order.data.payload.valueAtDonationTimeUSD && order.data.payload.netValueAmount
      ? Math.round((order.data.payload.valueAtDonationTimeUSD - order.data.payload.netValueAmount) * 100)
      : 0;
  const paymentProcessorFeeInHostCurrency = Math.round(paymentProcessorFee * hostCurrencyFxRate);

  const transactionPayload = {
    ...pick(order, ['CreatedByUserId', 'FromCollectiveId', 'CollectiveId', 'PaymentMethodId']),
    type: TransactionTypes.CREDIT,
    OrderId: order.id,
    amount,
    currency,
    hostCurrency,
    hostCurrencyFxRate,
    amountInHostCurrency,
    hostFeeInHostCurrency,
    taxAmount: order.taxAmount,
    description: order.description,
    paymentProcessorFeeInHostCurrency,
    data: {
      hasPlatformTip: !!platformTip,
      isSharedRevenue,
      platformTipEligible,
      platformTip,
      platformTipInHostCurrency,
      hostFeeSharePercent,
    },
  };

  return models.Transaction.createFromContributionPayload(transactionPayload);
};

function hexToBuffer(str) {
  return Buffer.from(str, 'hex');
}

export function decryptPayload(payload) {
  const decipher = crypto.createDecipheriv(
    AES_ENCRYPTION_METHOD,
    hexToBuffer(AES_ENCRYPTION_KEY),
    hexToBuffer(AES_ENCRYPTION_IV),
  );
  const decrypted = decipher.update(hexToBuffer(payload));
  return Buffer.concat([decrypted, decipher.final()]).toString('utf8');
}

export default {
  types: {
    crypto: {
      features: {
        recurring: false,
        waitToCharge: false,
      },
      processOrder,
      confirmOrder,
    },
  },
};
