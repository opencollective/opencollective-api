import config from 'config';
import { PlaidClient, PlaidEnvironment } from 'plaid';

let plaidClient: PlaidClient | undefined;

/**
 * A client created without an environment sends requests to Production, so an unknown
 * `PLAID_ENV` is an error rather than a fallback.
 */
const getPlaidEnvironment = (env: string): PlaidEnvironment => {
  switch (env) {
    case 'production':
      return PlaidEnvironment.Production;
    case 'sandbox':
      return PlaidEnvironment.Sandbox;
    default:
      throw new Error(`Unsupported Plaid environment: ${env}`);
  }
};

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
    plaidClient = new PlaidClient({
      clientId: config.plaid.clientId,
      secret: config.plaid.secret,
      version: '2020-09-14',
      environment: getPlaidEnvironment(config.plaid.env),
    });
  }

  return plaidClient;
};
