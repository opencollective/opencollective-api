import { truncate } from 'lodash';
import { CountryCode, ItemPublicTokenExchangeResponse, Products } from 'plaid';

import { Service } from '../../constants/connected-account';
import PlatformConstants from '../../constants/platform';
import { Collective, ConnectedAccount, sequelize, TransactionsImport, User } from '../../models';
import { reportErrorToSentry } from '../sentry';

import { PlaidClient } from './client';

export const generatePlaidLinkToken = async (
  remoteUser: User,
  products: Array<Products | `${Products}`>,
  countryCodes: Array<CountryCode | `${CountryCode}`>,
) => {
  const linkTokenConfig = {
    /* eslint-disable camelcase */
    user: { client_user_id: remoteUser.id.toString() },
    client_name: PlatformConstants.PlatformName,
    language: 'en',
    products: products as Products[],
    country_codes: countryCodes as CountryCode[],
    // TODO: webhook: 'https://www.example.com/webhook',
    /* eslint-enable camelcase */
  };

  const tokenResponse = await PlaidClient.linkTokenCreate(linkTokenConfig);
  return tokenResponse.data;
};

export const connectPlaidAccount = async (
  remoteUser: User,
  host: Collective,
  publicToken: string,
  { sourceName, name }: { sourceName: string; name: string },
) => {
  // Permissions check
  if (!remoteUser.isAdminOfCollective(host)) {
    throw new Error('You must be an admin of the host to connect a Plaid account to it');
  } else if (!host.isHostAccount) {
    throw new Error('You can only connect a Plaid account to a host account');
  }

  // Exchange Plaid public token
  let exchangeTokenResponse: ItemPublicTokenExchangeResponse;
  try {
    const exchangeTokenAxiosResponse = await PlaidClient.itemPublicTokenExchange({
      /* eslint-disable camelcase */
      public_token: publicToken,
      /* eslint-enable camelcase */
    });

    exchangeTokenResponse = exchangeTokenAxiosResponse.data;
  } catch (error) {
    const errorData = error.response?.data;
    if (!errorData) {
      throw new Error("A network occurred while exchanging Plaid's public token");
    } else if (errorData.error_code === 'INVALID_PUBLIC_TOKEN') {
      throw new Error('Provided Plaid public token is invalid');
    } else {
      reportErrorToSentry(error, { extra: { errorData }, user: remoteUser });
      throw new Error("An error occurred while exchanging Plaid's public token");
    }
  }

  // Create connected account
  return sequelize.transaction(async transaction => {
    const transactionsImport = await TransactionsImport.createWithActivity(
      remoteUser,
      host,
      {
        type: 'PLAID',
        source: truncate(sourceName, { length: 255 }) || 'Bank',
        name: truncate(name, { length: 255 }) || 'Bank Account',
      },
      { transaction },
    );

    const connectedAccount = await ConnectedAccount.create(
      {
        CollectiveId: host.id,
        service: Service.PLAID,
        clientId: exchangeTokenResponse['item_id'],
        token: exchangeTokenResponse['access_token'],
        CreatedByUserId: remoteUser.id,
        data: {
          transactionsImportId: transactionsImport.id,
        },
      },
      { transaction },
    );

    return { connectedAccount, transactionsImport };
  });
};
