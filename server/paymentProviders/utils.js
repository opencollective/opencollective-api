export const getConnectedAccountForPaymentProvider = async (host, provider) => {
  const [connectedAccount] = await host.getConnectedAccounts({ where: { service: provider } });

  if (!connectedAccount) {
    throw new Error(`Host ${host.slug} is not connected to ${provider}`);
  }

  return connectedAccount;
};
