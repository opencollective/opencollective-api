import fetch from 'node-fetch';

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
    // fetch hostCollectiveId
    const host = await order.collective.getHostCollective();

    // retrieve credentials
    const account = await models.ConnectedAccount.findOne({
      where: { CollectiveId: host.id, service: 'thegivingblock' },
    });

    // refresh credentials
    const result = await refresh(account.data.refreshToken);
    account.data.accessToken = result.accessToken;
    account.data.refreshToken = result.refreshToken;
    await account.save();

    // create wallet address
    const { depositAddress } = await createDepositAddress(account.data.accessToken, {
      organizationId: account.organizationId,
      pledgeAmount: order.data.pledgeAmount,
      pledgeCurrency: order.data.pledgeCurrency,
    });

    // update payment method
    order.paymentMethod.data = order.paymentMethod.data || {};
    order.paymentMethod.data.depositAddress = depositAddress;
    await order.paymentMethod.save();

    return order;
  },
};

export default {
  types: {
    crypto,
  },
};
