import config from 'config';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

let plaidClient: PlaidApi | undefined;

export const getPlaidClient = ({ throwIfMissing = true } = {}) => {
  // Check config
  if (!config.plaid || !config.plaid.clientId || !config.plaid.secret) {
    if (throwIfMissing) {
      throw new Error('Plaid credentials are missing');
    } else {
      return undefined;
    }
  }

  // Initialize as a singleton
  if (!plaidClient) {
    plaidClient = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[config.plaid.env],
        baseOptions: {
          headers: {
            'PLAID-CLIENT-ID': config.plaid.clientId,
            'PLAID-SECRET': config.plaid.secret,
            'Plaid-Version': '2020-09-14',
          },
        },
      }),
    );
  }

  return plaidClient;
};
