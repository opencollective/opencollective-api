import config from 'config';
import { omit, truncate } from 'lodash';
import { CountryCode, ItemPublicTokenExchangeResponse, LinkTokenCreateRequest, Products } from 'plaid';

import { Service } from '../../constants/connected-account';
import PlatformConstants from '../../constants/platform';
import { Collective, ConnectedAccount, sequelize, TransactionsImport, User } from '../../models';
import { reportErrorToSentry } from '../sentry';

import { getPlaidClient } from './client';
import { getPlaidWebhookUrl } from './webhooks';

// See https://plaid.com/docs/api/link/#link-token-create-request-language
const PlaidSupportedLocales = [
  'da',
  'nl',
  'en',
  'et',
  'fr',
  'de',
  'hi',
  'it',
  'lv',
  'lt',
  'no',
  'pl',
  'pt',
  'ro',
  'es',
  'sv',
  'vi',
] as const;

const getPlaidLanguage = (locale: string): (typeof PlaidSupportedLocales)[number] => {
  if (locale) {
    locale = locale.toLowerCase().split('-')[0].trim();
    if ((PlaidSupportedLocales as readonly string[]).includes(locale)) {
      return locale as (typeof PlaidSupportedLocales)[number];
    }
  }

  return 'en';
};

export const generatePlaidLinkToken = async (
  remoteUser: User,
  params: {
    products: readonly (Products | `${Products}`)[];
    countries: readonly (CountryCode | `${CountryCode}`)[];
    locale: string;
    accessToken?: string;
    /** If `accessToken` is provided, this flag will enable the account selection flow */
    accountSelectionEnabled?: boolean;
  },
) => {
  /* eslint-disable camelcase */
  const linkTokenConfig: LinkTokenCreateRequest = {
    user: { client_user_id: remoteUser.id.toString() },
    client_name: PlatformConstants.PlatformName,
    language: getPlaidLanguage(params.locale),
    products: params.products as Products[],
    country_codes: params.countries as CountryCode[],
    webhook: getPlaidWebhookUrl(),
    redirect_uri: `${config.host.website}/services/plaid/oauth/callback`, // Redirect URL must be listed in https://dashboard.plaid.com/developers/api
  };

  if (params.accessToken) {
    linkTokenConfig.access_token = params.accessToken;
    if (params.accountSelectionEnabled) {
      linkTokenConfig.update = { account_selection_enabled: true };
    }
  }
  /* eslint-enable camelcase */

  try {
    const PlaidClient = getPlaidClient();
    const tokenResponse = await PlaidClient.linkTokenCreate(linkTokenConfig);
    return tokenResponse.data;
  } catch (e) {
    reportErrorToSentry(e, { extra: { linkTokenConfig }, user: remoteUser });
    throw new Error('Failed to generate Plaid link token');
  }
};

export const connectPlaidAccount = async (
  remoteUser: User,
  host: Collective,
  publicToken: string,
  { sourceName, name }: { sourceName?: string; name?: string },
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
    const PlaidClient = getPlaidClient();
    const exchangeTokenAxiosResponse = await PlaidClient.itemPublicTokenExchange({
      /* eslint-disable camelcase */
      public_token: publicToken,
      /* eslint-enable camelcase */
    });

    exchangeTokenResponse = exchangeTokenAxiosResponse.data;
  } catch (error) {
    const errorData = error.response?.data;
    if (!errorData) {
      throw new Error('A network occurred while connecting Plaid');
    } else if (errorData.error_code === 'INVALID_PUBLIC_TOKEN') {
      throw new Error('Provided Plaid public token is invalid');
    } else {
      reportErrorToSentry(error, { extra: { errorData }, user: remoteUser });
      throw new Error('An error occurred while connecting Plaid');
    }
  }

  // Create connected account
  const result = await sequelize.transaction(async transaction => {
    const connectedAccount = await ConnectedAccount.create(
      {
        CollectiveId: host.id,
        service: Service.PLAID,
        clientId: exchangeTokenResponse['item_id'],
        token: exchangeTokenResponse['access_token'],
        CreatedByUserId: remoteUser.id,
        data: omit(exchangeTokenResponse, ['item_id', 'access_token']),
      },
      { transaction },
    );

    const transactionsImport = await TransactionsImport.createWithActivity(
      remoteUser,
      host,
      {
        type: 'PLAID',
        source: truncate(sourceName, { length: 255 }) || 'Bank',
        name: truncate(name, { length: 255 }) || 'Bank Account',
        ConnectedAccountId: connectedAccount.id,
      },
      { transaction },
    );

    // Record the transactions import ID in the connected account for audit purposes
    await connectedAccount.update(
      {
        data: {
          ...connectedAccount.data,
          transactionsImportId: transactionsImport.id,
        },
      },
      { transaction },
    );

    return { connectedAccount, transactionsImport };
  });

  // Try to update the list of sub accounts. This is not critical, so we don't fail the whole import if it doesn't work
  try {
    await refreshPlaidSubAccounts(result.connectedAccount, result.transactionsImport);
  } catch (error) {
    reportErrorToSentry(error, { user: remoteUser, extra: { connectedAccountId: result.connectedAccount.id } });
  }

  return result;
};

export const disconnectPlaidAccount = async (connectedAccount: ConnectedAccount): Promise<void> => {
  if (connectedAccount.service !== Service.PLAID) {
    throw new Error('Only Plaid accounts can be disconnected');
  }

  const PlaidClient = getPlaidClient();
  try {
    await PlaidClient.itemRemove({
      /* eslint-disable camelcase */
      access_token: connectedAccount.token,
      /* eslint-enable camelcase */
    });
  } catch (error) {
    const errorData = error.response?.data;
    if (!errorData) {
      throw new Error('A network error occurred while disconnecting the Plaid account');
    } else if (errorData.error_code === 'INVALID_ACCESS_TOKEN') {
      throw new Error('Provided Plaid access token is invalid');
    } else {
      reportErrorToSentry(error, { extra: { errorData } });
      throw new Error('An error occurred while disconnecting the Plaid account');
    }
  }

  await TransactionsImport.update({ ConnectedAccountId: null }, { where: { ConnectedAccountId: connectedAccount.id } });
};

export const refreshPlaidSubAccounts = async (
  connectedAccount: ConnectedAccount,
  transactionsImport: TransactionsImport,
) => {
  if (transactionsImport.type !== 'PLAID') {
    throw new Error('Only Plaid transactions imports can be refreshed');
  } else if (transactionsImport.ConnectedAccountId !== connectedAccount.id) {
    throw new Error('The connected account does not match the transactions import');
  }

  const PlaidClient = getPlaidClient();
  const { data } = await PlaidClient.accountsGet({ access_token: connectedAccount.token }); // eslint-disable-line camelcase
  await transactionsImport.update({
    data: {
      plaid: {
        availableAccounts: data.accounts.map(account => ({
          accountId: account.account_id,
          mask: account.mask,
          name: account.name,
          officialName: account.official_name,
          subtype: account.subtype,
          type: account.type,
        })),
      },
    },
  });
};
