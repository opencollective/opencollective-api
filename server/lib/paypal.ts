import paypal from '@paypal/payouts-sdk';

import { PayoutBatchDetails, PayoutRequestBody, PayoutRequestResult } from '../types/paypal';

const parseError = e => {
  try {
    return JSON.parse(e.message).message;
  } catch (_) {
    return e.message;
  }
};

interface ConnectedAccount {
  token: string;
  clientId: string;
}

const getPayPalClient = ({ token, clientId }: ConnectedAccount): ReturnType<typeof paypal.core.PayPalHttpClient> => {
  const environment =
    process.env.NODE_ENV === 'production'
      ? new paypal.core.LiveEnvironment(clientId, token)
      : new paypal.core.SandboxEnvironment(clientId, token);

  return new paypal.core.PayPalHttpClient(environment);
};

const executeRequest = async (
  connectedAccount: ConnectedAccount,
  request: PayoutRequestBody | Record<string, any>,
): Promise<any> => {
  try {
    const client = getPayPalClient(connectedAccount);
    const response = await client.execute(request);
    return response.result;
  } catch (e) {
    throw new Error(parseError(e));
  }
};

export const executePayouts = async (
  connectedAccount: ConnectedAccount,
  requestBody: PayoutRequestBody,
): Promise<PayoutRequestResult> => {
  const request = new paypal.payouts.PayoutsPostRequest();
  request.requestBody(requestBody);
  return executeRequest(connectedAccount, request);
};

export const getBatchInfo = async (
  connectedAccount: ConnectedAccount,
  batchId: string,
): Promise<PayoutBatchDetails> => {
  const request = new paypal.payouts.PayoutsGetRequest(batchId);
  request.page(1);
  request.pageSize(100);
  request.totalRequired(true);
  return executeRequest(connectedAccount, request);
};

export const validateConnectedAccount = async ({ token, clientId }: ConnectedAccount): Promise<void> => {
  const client = getPayPalClient({ token, clientId });
  await client.fetchAccessToken();
};

export { paypal };
