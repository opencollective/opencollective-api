import config from 'config';
import fetch from 'node-fetch';

import logger from '../../lib/logger';
import { getHostPaypalAccount } from '../../lib/paypal';
import models from '../../models';

/** Build an URL for the PayPal API */
export function paypalUrl(path: string, version = 'v1'): string {
  if (path.startsWith('/')) {
    throw new Error("Please don't use absolute paths");
  }
  const baseUrl =
    config.paypal.payment.environment === 'sandbox'
      ? `https://api.sandbox.paypal.com/${version}/`
      : `https://api.paypal.com/${version}/`;

  return new URL(baseUrl + path).toString();
}

/** Exchange clientid and secretid by an auth token with PayPal API */
export async function retrieveOAuthToken({ clientId, clientSecret }): Promise<string> {
  const url = paypalUrl('oauth2/token');
  const body = 'grant_type=client_credentials';
  /* The OAuth token entrypoint uses Basic HTTP Auth */
  const authStr = `${clientId}:${clientSecret}`;
  const basicAuth = Buffer.from(authStr).toString('base64');
  const headers = { Authorization: `Basic ${basicAuth}` };
  /* Execute the request and unpack the token */
  const response = await fetch(url, { method: 'post', body, headers });
  const jsonOutput = await response.json();
  return jsonOutput.access_token;
}

const parsePaypalError = async (
  response: Response,
  defaultMessage = 'PayPal request failed',
): Promise<{ message: string; metadata: { response: Response; error: Error | Record<string, unknown> } }> => {
  let error = null;
  let message = defaultMessage;

  // Parse error
  try {
    error = await response.json();
    message = `${message}: ${error.message}`;
  } catch (e) {
    error = e;
  }

  // Known errors
  if (error?.name === 'UNPROCESSABLE_ENTITY') {
    if (error.details?.[0]?.issue === 'INSTRUMENT_DECLINED') {
      message = 'The payment method was declined by PayPal. Please try with a different payment method.';
    }
  }

  return { message, metadata: { response, error } };
};

/** Assemble POST requests for communicating with PayPal API */
export async function paypalRequest(urlPath, body, hostCollective, method = 'POST'): Promise<Record<string, unknown>> {
  const paypal = await getHostPaypalAccount(hostCollective);
  if (!paypal) {
    throw new Error(`Host ${hostCollective.name} doesn't support PayPal payments.`);
  }

  const url = paypalUrl(urlPath);
  const token = await retrieveOAuthToken({ clientId: paypal.clientId, clientSecret: paypal.token });
  const params = {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  const result = await fetch(url, params);
  if (!result.ok) {
    const { message, metadata } = await parsePaypalError(result);
    logger.error('PayPal request failed', metadata);
    throw new Error(message);
  } else if (result.status === 204) {
    return null;
  } else {
    return result.json();
  }
}

export async function paypalRequestV2(
  urlPath: string,
  hostCollective: typeof models.Collective,
  method = 'POST',
  body = null,
): Promise<Record<string, unknown>> {
  const paypal = await getHostPaypalAccount(hostCollective);
  if (!paypal) {
    throw new Error(`Host ${hostCollective.name} doesn't support PayPal payments.`);
  }

  const url = paypalUrl(urlPath, 'v2');
  const token = await retrieveOAuthToken({ clientId: paypal.clientId, clientSecret: paypal.token });
  const params = {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  const result = await fetch(url, params);
  if (!result.ok) {
    const { message, metadata } = await parsePaypalError(result);
    logger.error('PayPal request failed', metadata);
    throw new Error(message);
  } else if (result.status === 204) {
    return null;
  } else {
    return result.json();
  }
}
