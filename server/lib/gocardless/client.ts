import config from 'config';
import NordigenClient from 'nordigen-node';

const TOKEN_VALIDITY = 23 * 60 * 60 * 1000; // It's valid for 24 hours, but we refresh it 1 hour before it expires

let gocardlessClient: NordigenClient | undefined;
let lastRefreshAt: number | null = null;

export const getGoCardlessClient = () => {
  if (!config.gocardless || !config.gocardless.secretId || !config.gocardless.secretKey) {
    throw new Error('The European bank account data provider is not available at this time');
  }

  if (!gocardlessClient) {
    // @ts-expect-error Property 'baseUrl' is missing in type [...] - see https://github.com/nordigen/nordigen-node/pull/64
    gocardlessClient = new NordigenClient({
      secretId: config.gocardless.secretId,
      secretKey: config.gocardless.secretKey,
    });
  }

  return gocardlessClient;
};

export const getOrRefreshGoCardlessToken = async (client: NordigenClient, { force = false } = {}): Promise<void> => {
  if (force || !lastRefreshAt || Date.now() >= lastRefreshAt + TOKEN_VALIDITY) {
    await client.generateToken();
    lastRefreshAt = Date.now();
  }
};
