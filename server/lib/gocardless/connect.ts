import { reportErrorToSentry } from '../sentry';

import { getGoCardlessClient } from './client';

// List available institutions
export const listGoCardlessInstitutions = async (country: string) => {
  try {
    const client = getGoCardlessClient();
    return await client.institutions.list({ country });
  } catch (e) {
    reportErrorToSentry(e, { extra: { country } });
    throw new Error('Failed to list GoCardless institutions');
  }
};

// Create an end user agreement
export const createGoCardlessAgreement = async (institutionId: string, options = {}) => {
  try {
    const client = getGoCardlessClient();
    return await client.agreements.create({ ['institution_id']: institutionId, ...options });
  } catch (e) {
    reportErrorToSentry(e, { extra: { institutionId, options } });
    throw new Error('Failed to create GoCardless agreement');
  }
};

// Create a requisition (build a link for user authentication)
export const createGoCardlessRequisition = async ({
  institutionId,
  redirect,
  reference,
  agreementId,
  userLanguage = 'EN',
}: {
  institutionId: string;
  redirect: string;
  reference: string;
  agreementId?: string;
  userLanguage?: string;
}) => {
  try {
    const client = getGoCardlessClient();
    return await client.requisitions.create({
      ['institution_id']: institutionId,
      redirect,
      reference,
      agreement: agreementId,
      ['user_language']: userLanguage,
    });
  } catch (e) {
    reportErrorToSentry(e, { extra: { institutionId, redirect, reference, agreementId, userLanguage } });
    throw new Error('Failed to create GoCardless requisition');
  }
};

// List accounts for a requisition
export const listGoCardlessAccounts = async (requisitionId: string) => {
  try {
    const client = getGoCardlessClient();
    return await client.requisitions.find(requisitionId);
  } catch (e) {
    reportErrorToSentry(e, { extra: { requisitionId } });
    throw new Error('Failed to list GoCardless accounts');
  }
};

// Get account details, balances, and transactions
export const getGoCardlessAccountDetails = async (accountId: string) => {
  try {
    const client = getGoCardlessClient();
    return await client.accounts.find(accountId);
  } catch (e) {
    reportErrorToSentry(e, { extra: { accountId } });
    throw new Error('Failed to get GoCardless account details');
  }
};

export const getGoCardlessAccountBalances = async (accountId: string) => {
  try {
    const client = getGoCardlessClient();
    return await client.accounts.balances(accountId);
  } catch (e) {
    reportErrorToSentry(e, { extra: { accountId } });
    throw new Error('Failed to get GoCardless account balances');
  }
};

export const getGoCardlessAccountTransactions = async (accountId: string) => {
  try {
    const client = getGoCardlessClient();
    return await client.accounts.transactions(accountId);
  } catch (e) {
    reportErrorToSentry(e, { extra: { accountId } });
    throw new Error('Failed to get GoCardless account transactions');
  }
};
