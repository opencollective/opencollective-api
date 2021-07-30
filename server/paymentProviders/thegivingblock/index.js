import fetch from 'node-fetch';

// const baseUrl = `https://public-api.tgbwidget.com/v1`;
const baseUrl = `https://public-api-nstaging.tgbwidget.com/v1`;

export async function login(login, password) {
  const body = new URLSearchParams();
  body.set('login', login);
  body.set('password', password);

  const response = await fetch(`${baseUrl}/login`, { method: 'POST', body });
  const result = await response.json();

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

export async function createDepositAddress(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  const body = new URLSearchParams();
  body.set('organizationId', 99);
  body.set('isAnonymous', true);
  body.set('pledgeCurrency', 'BTC');
  body.set('pledgeAmount', '0.0001');

  const response = await fetch(`${baseUrl}/deposit-address`, { method: 'POST', body, headers });
  const result = await response.json();

  return result.data;
}
