import fetch from 'node-fetch';

import { getFxRate } from '../../lib/currency';
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

const crypto = {
  features: {
    recurring: false,
    waitToCharge: false,
  },

  processOrder: async order => {
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
    const { depositAddress } = await createDepositAddress(account.data.accessToken, {
      organizationId: account.data.organizationId,
      pledgeAmount: order.data.customData.pledgeAmount,
      pledgeCurrency: order.data.customData.pledgeCurrency,
    });

    // update payment method
    // TODO: update name?
    // TODO: update currency?
    await order.paymentMethod.update({ data: { ...order.paymentMethod.data, depositAddress } });

    // update approximative amount in order currency
    const cryptoToFiatFxRate = await getFxRate(order.data.customData.pledgeCurrency, order.currency);
    const totalAmount = Math.round(order.data.customData.pledgeAmount * cryptoToFiatFxRate);
    console.log({ cryptoToFiatFxRate, totalAmount });
    await order.update({ totalAmount });

    // Return nothing as processOrder usually returns a transaction
  },
};

export default {
  types: {
    crypto,
  },
};
