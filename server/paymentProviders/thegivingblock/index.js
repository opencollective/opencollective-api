import crypto from 'crypto';

import config from 'config';
import { pick } from 'lodash';
import fetch from 'node-fetch';

import { TransactionTypes } from '../../constants/transactions';
import { getFxRate } from '../../lib/currency';
import { getHostFee, getHostFeeSharePercent } from '../../lib/payments';
import models from '../../models';

// const baseUrl = `https://public-api.tgbwidget.com/v1`;
const baseUrl = `https://public-api-nstaging.tgbwidget.com/v1`;

export async function login(login, password) {
  const body = new URLSearchParams();
  body.set('login', login);
  body.set('password', password);

  const response = await fetch(`${baseUrl}/login`, { method: 'POST', body });
  const result = await response.json();

  // console.log(result);

  return result.data;
}

export async function refresh(refreshToken) {
  const body = new URLSearchParams();
  body.set('refreshToken', refreshToken);

  const response = await fetch(`${baseUrl}/refresh-tokens`, { method: 'POST', body });
  const result = await response.json();

  // console.log(result);

  return result.data;
}

export async function getOrganizationsList(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  const response = await fetch(`${baseUrl}/organizations/list`, { headers });
  const result = await response.json();

  // console.log(result);

  return result.data;
}

export async function createDepositAddress(accessToken, { organizationId, pledgeAmount, pledgeCurrency } = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  const body = new URLSearchParams();
  body.set('isAnonymous', true);
  body.set('organizationId', organizationId);
  body.set('pledgeAmount', pledgeAmount);
  body.set('pledgeCurrency', pledgeCurrency);

  const response = await fetch(`${baseUrl}/deposit-address`, { method: 'POST', body, headers });
  const result = await response.json();

  // console.log(result);

  return result.data;
}

export const processOrder = async order => {
  const host = await order.collective.getHostCollective();

  // retrieve current credentials
  const account = await models.ConnectedAccount.findOne({
    where: { CollectiveId: host.id, service: 'thegivingblock' },
  });

  // refresh credentials
  // TODO: we normally have to do it only every 2 hours but this handy for now
  const { accessToken, refreshToken } = await refresh(account.data.refreshToken);
  await account.update({ data: { ...account.data, accessToken, refreshToken } });

  // create wallet address
  const { depositAddress, pledgeId } = await createDepositAddress(account.data.accessToken, {
    organizationId: account.data.organizationId,
    pledgeAmount: order.data.customData.pledgeAmount,
    pledgeCurrency: order.data.customData.pledgeCurrency,
  });

  // update payment method
  // TODO: update name?
  // TODO: update currency?
  await order.paymentMethod.update({ data: { ...order.paymentMethod.data, depositAddress } });

  // Update order with pledgeId
  await order.update({ data: { ...order.data, pledgeId } });

  // update approximative amount in order currency
  const cryptoToFiatFxRate = await getFxRate(order.data.customData.pledgeCurrency, order.currency);
  if (cryptoToFiatFxRate) {
    const totalAmount = Math.round(order.data.customData.pledgeAmount * cryptoToFiatFxRate);
    await order.update({ totalAmount });
  }
};

export const confirmOrder = async order => {
  order.collective = order.collective || (await models.Collective.findByPk(order.CollectiveId));
  order.paymentMethod = order.paymentMethod || (await models.PaymentMethod.findByPk(order.PaymentMethodId));

  const host = await order.collective.getHostCollective();

  const hostFeeSharePercent = await getHostFeeSharePercent(order, host);
  const isSharedRevenue = !!hostFeeSharePercent;

  const amount = order.totalAmount;
  const currency = order.currency;
  const hostCurrency = host.currency;
  const hostCurrencyFxRate = await getFxRate(order.currency, hostCurrency);
  const amountInHostCurrency = Math.round(order.totalAmount * hostCurrencyFxRate);

  const hostFee = await getHostFee(order, host);
  const hostFeeInHostCurrency = Math.round(hostFee * hostCurrencyFxRate);

  const platformTipEligible = false;
  const platformTip = 0;
  const platformTipInHostCurrency = 0;
  const paymentProcessorFeeInHostCurrency = 0;

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
      isFeesOnTop: false,
      hasPlatformTip: platformTip ? true : false,
      isSharedRevenue,
      platformTipEligible,
      platformTip,
      platformTipInHostCurrency,
      hostFeeSharePercent,
    },
  };

  const creditTransaction = await models.Transaction.createFromContributionPayload(transactionPayload);

  return creditTransaction;
};

const AES_ENCRYPTION_KEY = config.thegivingblock.aesEncryptionKey;
const AES_ENCRYPTION_IV = config.thegivingblock.aesEncryptionIv;
const AES_METHOD = config.thegivingblock.aesEncryptionMethod || 'aes-256-cbc';

function hexToBuffer(str) {
  return Buffer.from(str, 'hex');
}

export function decryptPayload(payload) {
  const decipher = crypto.createDecipheriv(AES_METHOD, hexToBuffer(AES_ENCRYPTION_KEY), hexToBuffer(AES_ENCRYPTION_IV));
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
