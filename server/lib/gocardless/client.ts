import config from 'config';
import { GoCardlessClient } from 'gocardless-nodejs/client';
import { Environments } from 'gocardless-nodejs/constants';

let gocardlessClient;

export const getGoCardlessClient = ({ throwIfMissing = true } = {}) => {
  if (!config.gocardless || !config.gocardless.accessToken || !config.gocardless.env) {
    if (throwIfMissing) {
      throw new Error('GoCardless credentials are missing');
    } else {
      return undefined;
    }
  }

  if (!gocardlessClient) {
    gocardlessClient = new GoCardlessClient(config.gocardless.accessToken, Environments[config.gocardless.env], {
      raiseOnIdempotencyConflict: true,
    });
  }

  return gocardlessClient;
};
