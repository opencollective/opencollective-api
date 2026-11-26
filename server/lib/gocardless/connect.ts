import { randomUUID } from 'crypto';

import config from 'config';
import { truncate } from 'lodash';
import moment from 'moment';

import { Service } from '../../constants/connected-account';
import { Collective, ConnectedAccount, sequelize, TransactionsImport, User } from '../../models';
import cache, { sessionCache } from '../cache';
import { reportErrorToSentry } from '../sentry';

import { getGoCardlessClient, getOrRefreshGoCardlessToken } from './client';
import {
  EndUserAgreement,
  GoCardlessRequisitionStatus,
  Institution,
  Integration,
  IntegrationRetrieve,
  Requisition,
} from './types';

// See https://developer.gocardless.com/bank-account-data/endpoints.
// Keep this in sync with `opencollective-frontend/components/dashboard/sections/transactions-imports/NewOffPlatformTransactionsConnection.tsx`.
const supportedCountries = [
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czechia
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IS', // Iceland
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LI', // Liechtenstein
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'NO', // Norway
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
  'GB', // United Kingdom
] as const;

type GoCardlessAuthorizationData = {
  institution?: { max_access_valid_for_days?: string };
  requisition?: { created?: string };
};

export const getGoCardlessAuthorizationExpiresAt = (
  gocardlessData: GoCardlessAuthorizationData | null | undefined,
): Date | null => {
  const maxAccessValidForDays = gocardlessData?.institution?.max_access_valid_for_days;
  const requisitionCreated = gocardlessData?.requisition?.created;

  if (!maxAccessValidForDays || !requisitionCreated) {
    return null;
  }

  const accessValidForDays = parseInt(maxAccessValidForDays, 10);
  if (!accessValidForDays || Number.isNaN(accessValidForDays)) {
    return null;
  }

  const createdAt = moment.utc(requisitionCreated, moment.ISO_8601, true);
  if (!createdAt.isValid()) {
    return null;
  }

  return createdAt.add(accessValidForDays, 'days').toDate();
};

export const isGoCardlessSupportedCountry = (country: string): country is (typeof supportedCountries)[number] => {
  return (supportedCountries as readonly string[]).includes(country);
};

/**
 * GoCardless requisitions are initiated by an authenticated host admin, but the requisition ID only
 * comes back to us through a browser redirect (`/services/gocardless/callback`). The requisition ID
 * alone therefore proves nothing about who initiated the flow: without binding it to its initiator,
 * any host admin who gets hold of a requisition ID (e.g. from the redirect URL) could bind somebody
 * else's authorized bank connection to their own host.
 *
 * We record the initiator when the link is created, and verify it when the connection is completed.
 */
type GoCardlessLinkSession = { CollectiveId: number; UserId: number };

/**
 * The OAuth-like flow is short-lived (the user goes to their bank and comes back within minutes).
 */
const GOCARDLESS_LINK_SESSION_TTL = 60 * 30;

export const getGoCardlessLinkSessionCacheKey = (requisitionId: string): string =>
  `gocardless:link-session:${requisitionId}`;

const recordGoCardlessLinkSession = async (requisitionId: string, session: GoCardlessLinkSession): Promise<void> => {
  await sessionCache.set(getGoCardlessLinkSessionCacheKey(requisitionId), session, GOCARDLESS_LINK_SESSION_TTL);
};

/**
 * Makes sure `requisitionId` was initiated by `remoteUser` for the account identified by `CollectiveId`.
 *
 * This deliberately **fails closed**: a missing session (expired, evicted from the cache, or created
 * before this check was deployed) is rejected. Accepting unbound requisitions would defeat the control
 * entirely, since an attacker only has to wait for the entry to expire before claiming a requisition
 * they did not initiate. Users hitting this simply need to restart the connection flow.
 */
const assertGoCardlessRequisitionWasInitiatedBy = async (
  remoteUser: User,
  CollectiveId: number,
  requisitionId: string,
): Promise<void> => {
  const session: GoCardlessLinkSession | undefined = await sessionCache.get(
    getGoCardlessLinkSessionCacheKey(requisitionId),
  );

  if (!session || session.CollectiveId !== CollectiveId || session.UserId !== remoteUser.id) {
    throw new Error(
      'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
    );
  }
};

const clearGoCardlessLinkSession = async (requisitionId: string): Promise<void> => {
  await sessionCache.delete(getGoCardlessLinkSessionCacheKey(requisitionId));
};

export const getGoCardlessInstitutions = async (
  country: (typeof supportedCountries)[number],
  options: { forceRefresh?: boolean } = {},
): Promise<Integration[]> => {
  const { forceRefresh = false } = options;
  const cacheKey = `gocardless:institutions:${country}`;
  const cacheDuration = 24 * 60 * 60; // 24 hours

  // Try to get from cache first (unless forceRefresh is true)
  if (!forceRefresh) {
    const cachedInstitutions = await cache.get(cacheKey);
    if (cachedInstitutions) {
      return cachedInstitutions;
    }
  }

  // Fetch from GoCardless API
  const client = getGoCardlessClient();
  await getOrRefreshGoCardlessToken(client);
  const institutions = await client.institution.getInstitutions({ country });

  // Cache the results
  await cache.set(cacheKey, institutions, cacheDuration);

  return institutions;
};

export const createGoCardlessLink = async (
  remoteUser: User,
  host: Collective,
  institutionId: string,
  {
    maxHistoricalDays,
    accessValidForDays,
    userLanguage = 'en',
    ssn = null,
    redirectImmediate = false,
    accountSelection = false,
  },
): Promise<Requisition> => {
  const redirectUrl = `${config.host.website}/services/gocardless/callback`;
  const client = getGoCardlessClient();
  await getOrRefreshGoCardlessToken(client);

  try {
    const institution = (await client.institution.getInstitutionById(institutionId)) as Institution;
    if (!institution) {
      throw new Error(`The institution ${institutionId} was not found`);
    }

    // Create agreement
    const agreement: EndUserAgreement = await client.agreement.createAgreement({
      maxHistoricalDays: maxHistoricalDays || parseInt(institution.transaction_total_days) || 90,
      accessValidForDays: accessValidForDays || parseInt(institution.max_access_valid_for_days) || 180,
      institutionId: institutionId,
    });

    // Create new requisition
    let requisition: Requisition;
    const requisitionParams = {
      redirectUrl: redirectUrl,
      institutionId: institutionId,
      reference: randomUUID(),
      agreement: agreement.id,
      userLanguage: userLanguage,
      redirectImmediate: redirectImmediate,
      accountSelection: accountSelection,
      ssn: ssn,
    };

    try {
      requisition = await client.requisition.createRequisition(requisitionParams);
    } catch (error) {
      if (error.response?.data?.account_selection?.summary === 'Account selection not supported') {
        requisition = await client.requisition.createRequisition({ ...requisitionParams, accountSelection: false });
      } else {
        throw error;
      }
    }

    // Bind the requisition to whoever initiated it, so that nobody else can claim it when it comes
    // back from the bank through the redirect. See `assertGoCardlessRequisitionWasInitiatedBy`.
    await recordGoCardlessLinkSession(requisition.id, { CollectiveId: host.id, UserId: remoteUser.id });

    return requisition;
  } catch (error) {
    reportErrorToSentry(error, {
      user: remoteUser,
      extra: {
        CollectiveId: host.id,
        institutionId,
        maxHistoricalDays,
        accessValidForDays,
        userLanguage,
        ssn,
        redirectImmediate,
        accountSelection,
      },
    });

    throw new Error('Failed to create open banking link');
  }
};

export const connectGoCardlessAccount = async (
  remoteUser: User,
  host: Collective,
  requisitionId: string,
  { sourceName, name }: { sourceName?: string; name?: string } = {},
) => {
  // Make sure this requisition was initiated by this user, for this host
  await assertGoCardlessRequisitionWasInitiatedBy(remoteUser, host.id, requisitionId);

  const client = getGoCardlessClient();
  await getOrRefreshGoCardlessToken(client);

  if (await ConnectedAccount.count({ where: { service: Service.GOCARDLESS, clientId: requisitionId } })) {
    throw new Error('This connection already exists');
  }

  const requisition = (await client.requisition.getRequisitionById(requisitionId)) as Requisition;
  if (requisition.status !== GoCardlessRequisitionStatus.LN) {
    throw new Error(`The connection for ${requisitionId} is not linked`);
  } else if (!requisition.accounts?.length) {
    throw new Error('We did not receive any accounts for this connection');
  }

  const institution = (await client.institution.getInstitutionById(requisition.institution_id)) as IntegrationRetrieve;
  if (!institution) {
    throw new Error(`The institution ${requisition.institution_id} was not found`);
  }

  const accountsMetadata = await Promise.all(
    requisition.accounts.map(accountId => client.account(accountId).getMetadata()),
  );

  const authorizationExpiresAt = getGoCardlessAuthorizationExpiresAt({
    institution,
    requisition,
  });

  const result = await sequelize.transaction(async transaction => {
    const connectedAccount = await ConnectedAccount.create(
      {
        CollectiveId: host.id,
        CreatedByUserId: remoteUser.id,
        service: Service.GOCARDLESS,
        clientId: requisition.id,
        authorizationExpiresAt,
        data: {
          gocardless: {
            requisition,
            institution,
            accountsMetadata,
          },
        },
      },
      {
        transaction,
      },
    );

    const transactionsImport = await TransactionsImport.createWithActivity(
      remoteUser,
      host,
      {
        CollectiveId: host.id,
        type: 'GOCARDLESS',
        ConnectedAccountId: connectedAccount.id,
        source: truncate(sourceName || institution.name, { length: 255 }) || 'Bank',
        name:
          truncate(name || accountsMetadata.map(account => account.name).join(', '), { length: 255 }) || `Bank account`,
        data: { ...connectedAccount.data },
      },
      { transaction },
    );

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

  await clearGoCardlessLinkSession(requisitionId);

  return result;
};

/**
 * Reconnect a GoCardless account by creating a new link and updating the existing connection.
 * This is a placeholder function - the actual implementation will be handled separately.
 */
export const reconnectGoCardlessAccount = async (
  remoteUser: User,
  connectedAccount: ConnectedAccount,
  transactionsImport: TransactionsImport,
  requisitionId: string,
) => {
  if (connectedAccount.service !== Service.GOCARDLESS) {
    throw new Error('Connected account is not a GoCardless account');
  }

  // Reconnecting also goes through `createGoCardlessLink`, so the same session binding applies. The
  // exposure is smaller than for `connectGoCardlessAccount` (the requisition must match the existing
  // institution and at least one of the existing IBANs), but we enforce it consistently.
  await assertGoCardlessRequisitionWasInitiatedBy(remoteUser, connectedAccount.CollectiveId, requisitionId);

  const client = getGoCardlessClient();
  await getOrRefreshGoCardlessToken(client);

  // Fetch & check the new requisition
  const requisition = (await client.requisition.getRequisitionById(requisitionId)) as Requisition;
  if (requisition.status !== GoCardlessRequisitionStatus.LN) {
    throw new Error(`The connection for ${connectedAccount.clientId} is not linked`);
  } else if (!requisition.accounts?.length) {
    throw new Error('We did not receive any accounts for this connection');
  } else if (requisition.institution_id !== connectedAccount.data?.gocardless?.institution?.id) {
    throw new Error('The selected institution is different from the one associated with this connection');
  }

  // Fetch & check account details - make sure we've connected to the same accounts (at least 1 must match)
  const accountsMetadata = await Promise.all(
    requisition.accounts.map(accountId => client.account(accountId).getMetadata()),
  );

  if (
    !accountsMetadata.some(accountMetadata =>
      connectedAccount.data?.gocardless?.accountsMetadata.some(
        connectedAccountMetadata => connectedAccountMetadata.iban === accountMetadata.iban,
      ),
    )
  ) {
    throw new Error('The selected accounts are different from the ones associated with this connection');
  }

  const authorizationExpiresAt = getGoCardlessAuthorizationExpiresAt({
    institution: connectedAccount.data?.gocardless?.institution,
    requisition,
  });

  // Update the connected account with the new requisition data
  const result = await sequelize.transaction(async transaction => {
    await connectedAccount.update(
      {
        authorizationExpiresAt,
        data: {
          ...connectedAccount.data,
          gocardless: {
            ...connectedAccount.data?.gocardless,
            requisition,
            accountsMetadata,
          },
        },
      },
      { transaction },
    );

    await transactionsImport.update(
      {
        data: {
          ...transactionsImport.data,
          gocardless: {
            ...transactionsImport.data?.gocardless,
            ...connectedAccount.data?.gocardless,
          },
        },
      },
      { transaction },
    );

    return { connectedAccount, transactionsImport };
  });

  await clearGoCardlessLinkSession(requisitionId);

  return result;
};

export const disconnectGoCardlessAccount = async (connectedAccount: ConnectedAccount): Promise<void> => {
  if (connectedAccount.service !== Service.GOCARDLESS) {
    throw new Error('Only GoCardless accounts can be disconnected');
  }

  const client = getGoCardlessClient();
  await getOrRefreshGoCardlessToken(client);
  try {
    await client.requisition.deleteRequisition(connectedAccount.clientId);
  } catch (error) {
    // Ignore 404 errors, they are expected when the requisition is already deleted from somewhere else
    if (error.response?.status === 404) {
      return;
    } else {
      throw error;
    }
  }
};
