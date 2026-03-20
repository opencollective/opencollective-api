import config from 'config';
import fetch, { Response } from 'node-fetch';

import logger from '../../lib/logger';
import { getHostPaypalAccount } from '../../lib/paypal';
import { reportMessageToSentry } from '../../lib/sentry';
import { Collective } from '../../models';

import { PaypalUserInfo } from './types';

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

/** Build the PayPal authorization URL for "Log in with PayPal" */
export function paypalConnectAuthorizeUrl(): string {
  return config.paypal.payment.environment === 'sandbox'
    ? 'https://www.sandbox.paypal.com/connect/'
    : 'https://www.paypal.com/connect/';
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

/**
 * Exchange an authorization code for a user access + refresh token using the platform PayPal Connect app.
 * Used in the "Log in with PayPal" flow.
 */
export async function exchangeAuthCodeForToken(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  nonce: string;
  state: string;
}> {
  const url = paypalUrl('oauth2/token');
  const authStr = `${config.paypal.connect.clientId}:${config.paypal.connect.clientSecret}`;
  const basicAuth = Buffer.from(authStr).toString('base64');
  const headers = { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', config.paypal.connect.redirectUri); // TODO: Should be auto-generated if missing

  const response = await fetch(url, { method: 'post', body, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `PayPal token exchange failed (${response.status}): ${(error as any).error_description || response.statusText}`,
    );
  }

  return response.json();
}

/**
 * Refresh a user's PayPal access token using their stored refresh token.
 */
export async function refreshPaypalUserToken(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const url = paypalUrl('oauth2/token');
  const authStr = `${config.paypal.connect.clientId}:${config.paypal.connect.clientSecret}`;
  const basicAuth = Buffer.from(authStr).toString('base64');
  const headers = { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);

  const response = await fetch(url, { method: 'post', body, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `PayPal token refresh failed (${response.status}): ${(error as any).error_description || response.statusText}`,
    );
  }
  return response.json();
}

/**
 * Retrieve the authenticated user's PayPal identity information using their access token.
 * Requires the `openid`, `email`, and `https://uri.paypal.com/services/paypalattributes` scopes.
 */
export async function retrievePaypalUserInfo(accessToken: string): Promise<PaypalUserInfo> {
  const url = `${paypalUrl('identity/oauth2/userinfo')}?schema=paypalv1.1`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const response = await fetch(url, { method: 'get', headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `PayPal userinfo request failed (${response.status}): ${(error as any).message || response.statusText}`,
    );
  }
  return response.json();
}

/**
 * Retrieve the list of scopes granted to a host's PayPal application credentials.
 * Used to verify that required APIs are enabled on the PayPal account.
 */
export async function retrieveGrantedScopes(clientId: string, clientSecret: string): Promise<string[]> {
  const url = paypalUrl('oauth2/token');
  const body = 'grant_type=client_credentials';
  const authStr = `${clientId}:${clientSecret}`;
  const basicAuth = Buffer.from(authStr).toString('base64');
  const headers = { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const response = await fetch(url, { method: 'post', body, headers });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `PayPal credentials check failed (${response.status}): ${(error as any).error_description || response.statusText}`,
    );
  }
  const result = (await response.json()) as { scope?: string };
  return result.scope ? result.scope.split(' ') : [];
}

const parsePaypalError = async (
  response: Response,
  defaultMessage = 'PayPal request failed',
): Promise<{
  message: string;
  metadata: { response: Response; error: Error | Record<string, unknown>; status: number; url: string };
}> => {
  let error = null;
  let message = defaultMessage;

  // Parse error
  try {
    const rawBody = await response.text();
    if (rawBody) {
      error = JSON.parse(rawBody);
      message = `${message} (${response.status}): ${error.message}`;
    } else {
      error = null;
      message = `${message} (${response.status}): ${response.statusText}`;
    }
  } catch (e) {
    error = e;
    message = `PayPal request failed (${response.status}): unable to parse error`;
  }

  // Known errors
  if (error?.name === 'UNPROCESSABLE_ENTITY' && error.details?.[0]) {
    const errorDetails = error.details[0];
    if (errorDetails.issue === 'INSTRUMENT_DECLINED') {
      message = 'The payment method was declined by PayPal. Please try with a different payment method.';
    } else if (errorDetails.issue === 'REFUND_FAILED_INSUFFICIENT_FUNDS') {
      message =
        'Capture could not be refunded due to insufficient funds. Please check to see if you have sufficient funds in your PayPal account or if the bank account linked to your PayPal account is verified and has sufficient funds.';
    } else {
      message = `${message} (${errorDetails.issue})`;
    }
  }

  return { message, metadata: { response, error, status: response.status, url: response.url } };
};

/** Assemble POST requests for communicating with PayPal API */
export async function paypalRequest(
  urlPath,
  body,
  hostCollective,
  method = 'POST',
  { shouldReportErrors = true } = {},
): Promise<Record<string, unknown>> {
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

  const result: Response = await fetch(url, params);
  if (!result.ok) {
    const { message, metadata } = await parsePaypalError(result);
    const error = new Error(message);
    error['metadata'] = metadata;
    if (shouldReportErrors) {
      logger.error('PayPal request failed', metadata);
      reportMessageToSentry('PayPal request failed', { extra: metadata });
    }

    throw error;
  } else if (result.status === 204) {
    return null;
  } else {
    return result.json();
  }
}

export async function paypalRequestV2(
  urlPath: string,
  hostCollective: Collective,
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

  const result: Response = await fetch(url, params);
  if (!result.ok) {
    const { message, metadata } = await parsePaypalError(result);
    logger.error(`PayPal request V2 failed`, metadata);
    reportMessageToSentry(`PayPal request V2 failed`, { extra: metadata });
    throw new Error(message);
  } else if (result.status === 204) {
    return null;
  } else {
    return result.json();
  }
}
