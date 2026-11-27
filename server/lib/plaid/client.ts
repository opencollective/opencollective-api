import config from 'config';
import { PlaidClient, PlaidEnvironment, PlaidError, PlaidTimeoutError } from 'plaid';

let plaidClient: PlaidClient | undefined;

/**
 * Maps `config.plaid.env` to a Plaid environment. The new SDK defaults to Production when no
 * environment is given, so we resolve it explicitly and refuse unknown values.
 */
export const getPlaidEnvironment = (env: string = config.plaid?.env): PlaidEnvironment => {
  switch (env) {
    case 'sandbox':
      return PlaidEnvironment.Sandbox;
    case 'production':
      return PlaidEnvironment.Production;
    default:
      throw new Error(`Invalid Plaid environment: ${env}`);
  }
};

export const createPlaidClient = ({ clientId, secret, env }: { clientId: string; secret: string; env: string }) => {
  return new PlaidClient({
    environment: getPlaidEnvironment(env),
    clientId,
    secret,
    version: '2020-09-14',
    timeoutInSeconds: 60,
  });
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
    plaidClient = createPlaidClient(config.plaid);
  }

  return plaidClient;
};

/**
 * Returns the error payload Plaid sent back (`error_code`, `error_type`, `error_message`...), or `undefined`
 * if the request never got a response from Plaid (network error, timeout, non-JSON body).
 * See https://plaid.com/docs/errors/.
 */
export const getPlaidErrorData = (
  error: unknown,
): { error_code?: string; error_type?: string; error_message?: string } | undefined => {
  if (!(error instanceof PlaidError) || error instanceof PlaidTimeoutError || !error.statusCode) {
    return undefined;
  } else if (!error.body || typeof error.body !== 'object') {
    return undefined;
  } else {
    return error.body;
  }
};
