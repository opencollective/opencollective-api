import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

// Set up the Plaid client
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments['sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
      'Plaid-Version': '2020-09-14',
    },
  },
});

export const PlaidClient = new PlaidApi(plaidConfig);
