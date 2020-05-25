import paypalPayoutsSDK from '@paypal/payouts-sdk';

interface ConnectedAccount {
  token: string;
  clientId: string;
}

const getPayPalClient = ({ token, clientId }: ConnectedAccount) => {
  const environment =
    process.env.NODE_ENV === 'production'
      ? new paypalPayoutsSDK.core.LiveEnvironment(clientId, token)
      : new paypalPayoutsSDK.core.SandboxEnvironment(clientId, token);

  return new paypalPayoutsSDK.core.PayPalHttpClient(environment);
};

export const validateConnectedAccount = async ({ token, clientId }: ConnectedAccount): Promise<void> => {
  const paypal = getPayPalClient({ token, clientId });
  await paypal.fetchAccessToken();
};
