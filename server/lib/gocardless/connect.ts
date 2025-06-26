import { randomUUID } from 'crypto';

import { AxiosError } from 'axios';
import config from 'config';

import cache from '../cache';
import { reportErrorToSentry } from '../sentry';

import { getGoCardlessClient, getOrRefreshGoCardlessToken } from './client';
import { EndUserAgreement, Integration, Requisition } from './types';

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

export const isGoCardlessSupportedCountry = (country: string): country is (typeof supportedCountries)[number] => {
  return (supportedCountries as readonly string[]).includes(country);
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
  institutionId: string,
  {
    maxHistoricalDays = 90,
    accessValidForDays = 90,
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
    // Create agreement
    const agreement: EndUserAgreement = await client.agreement.createAgreement({
      maxHistoricalDays: maxHistoricalDays,
      accessValidForDays: accessValidForDays,
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

    return requisition;
  } catch (error) {
    reportErrorToSentry(error, {
      extra: {
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
