import { compact, uniq } from 'lodash';

import { isAccountHolderNameAndLegalNameMatch } from '../../graphql/common/expenses';
import LegalDocument, { LEGAL_DOCUMENT_SERVICE } from '../../models/LegalDocument';
import { StructuredAddress } from '../../types/Location';
import { reportErrorToSentry } from '../sentry';

import {
  getStandardizedDataFromOCLegalDocumentData,
  isW8BenData,
  isW8BenEData,
  isW9Data,
  W8BenETaxFormValues,
  W8BenTaxFormValues,
  W9TaxFormValues,
} from './opencollective';
import { TaxFormCSVColumns } from './types';

type LegalDocumentAddress = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  zone: string | null;
  postalCode: string | null;
  country: string | null;
};

/**
 * The subset of a legal document that is relevant to compare against the payee's account information.
 * Tax IDs are deliberately excluded: they must never leave the encrypted payload.
 */
export type LegalDocumentIdentity = {
  formType: string | null;
  individualName: string | null;
  entityName: string | null;
  address: LegalDocumentAddress;
  /** ISO 3166-1 alpha-2 country of residence, when it can be normalized. */
  country: string | null;
  email: string | null;
};

type AddressComparisonInput = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zone?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue || null;
};

const normalizeCountryToISO = (country?: string | null): string | null => {
  const normalizedCountry = normalizeString(country);
  return normalizedCountry && /^[a-z]{2}$/i.test(normalizedCountry) ? normalizedCountry.toUpperCase() : null;
};

const hasIdentityData = (identity: LegalDocumentIdentity): boolean => {
  return Boolean(
    identity.formType ||
    identity.individualName ||
    identity.entityName ||
    identity.email ||
    identity.country ||
    identity.address.address1 ||
    identity.address.address2 ||
    identity.address.city ||
    identity.address.zone ||
    identity.address.postalCode,
  );
};

const decryptFormData = (encryptedFormData: string, legalDocument: LegalDocument): Record<string, unknown> | null => {
  try {
    const payload = JSON.parse(LegalDocument.decrypt(Buffer.from(encryptedFormData, 'base64')).toString());
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch (error) {
    reportErrorToSentry(error as Error, {
      extra: { legalDocumentId: legalDocument.id, collectiveId: legalDocument.CollectiveId },
    });
    return null;
  }
};

const getStructuredAddressFromOCFormValues = (
  formValues: Record<string, unknown>,
): StructuredAddress | null | undefined => {
  if (isW9Data(formValues)) {
    return formValues.location?.structured;
  } else if (isW8BenData(formValues)) {
    return formValues.residenceAddress?.structured;
  } else if (isW8BenEData(formValues)) {
    return formValues.businessAddress?.structured;
  } else {
    return null;
  }
};

const buildIdentityFromOpenCollective = (legalDocument: LegalDocument): LegalDocumentIdentity | null => {
  const formValues = decryptFormData(legalDocument.data.encryptedFormData, legalDocument);
  if (!formValues) {
    return null;
  }

  const standardizedData = getStandardizedDataFromOCLegalDocumentData(
    formValues as W9TaxFormValues | W8BenTaxFormValues | W8BenETaxFormValues,
  );
  const structuredAddress = getStructuredAddressFromOCFormValues(formValues);
  const country = normalizeCountryToISO(standardizedData[TaxFormCSVColumns.RECIPIENT_COUNTRY]);

  const identity: LegalDocumentIdentity = {
    formType: standardizedData[TaxFormCSVColumns.TYPE] || null,
    individualName: normalizeString(standardizedData[TaxFormCSVColumns.RECIPIENT_NAME]),
    entityName: normalizeString(standardizedData[TaxFormCSVColumns.ENTITY]),
    address: {
      address1:
        normalizeString(standardizedData[TaxFormCSVColumns.RECIPIENT_ADDRESS_1]) ||
        normalizeString(structuredAddress?.address1),
      address2: normalizeString(structuredAddress?.address2),
      city: normalizeString(structuredAddress?.city),
      zone: normalizeString(structuredAddress?.zone),
      postalCode: normalizeString(structuredAddress?.postalCode),
      country,
    },
    country,
    email: normalizeString(standardizedData[TaxFormCSVColumns.RECIPIENT_EMAIL]),
  };

  return hasIdentityData(identity) ? identity : null;
};

/**
 * Decrypts and normalizes the identity submitted in a legal document. Returns `null` when there is nothing
 * usable to compare (missing document, legacy HelloWorks document, unreadable payload, unknown form shape).
 */
export const getLegalDocumentIdentity = (
  legalDocument: LegalDocument | null | undefined,
): LegalDocumentIdentity | null => {
  if (!legalDocument?.data?.encryptedFormData) {
    return null;
  }

  // HelloWorks/Dropbox Forms were retired in 2024: their legacy payloads are not compared anymore.
  if (legalDocument.service === LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS || legalDocument.data?.helloWorks?.instance) {
    return null;
  }

  return buildIdentityFromOpenCollective(legalDocument);
};

const normalizeAddressComponent = (value?: string | null): string | null => {
  const normalizedValue = normalizeString(value)?.replace(/\s+/g, ' ').toLowerCase();
  return normalizedValue || null;
};

/** Returns true only when both values are defined and differ, ignoring case and whitespace. */
const isDefinedButNotEqual = (valueA?: string | null, valueB?: string | null): boolean => {
  const normalizedValueA = normalizeAddressComponent(valueA);
  const normalizedValueB = normalizeAddressComponent(valueB);
  return Boolean(normalizedValueA && normalizedValueB && normalizedValueA !== normalizedValueB);
};

const formatAddressForDetails = (
  address: Pick<AddressComparisonInput, 'city' | 'zone' | 'postalCode' | 'country'> | null | undefined,
  country?: string | null,
): string => {
  const components = compact([
    normalizeString(address?.city),
    normalizeString(address?.zone),
    normalizeString(address?.postalCode),
  ]);
  const countryCode = normalizeCountryToISO(country || address?.country);
  const addressText = components.join(', ');
  return `${addressText}${countryCode ? ` (${countryCode})` : ''}`.trim();
};

/**
 * Compares the name submitted in the legal document to the payee name. Matching either the individual or the
 * entity name is enough. Returns `null` when matching or when there is nothing to compare.
 */
export const getLegalDocumentNameMismatchDetails = (
  identity: LegalDocumentIdentity | null | undefined,
  payeeName?: string | null,
  { nameLabel = 'payee name' }: { nameLabel?: string } = {},
): string | null => {
  if (!identity) {
    return null;
  }

  const formNames = uniq(compact([normalizeString(identity.individualName), normalizeString(identity.entityName)]));
  const legalName = normalizeString(payeeName);
  if (!formNames.length || !legalName) {
    return null;
  } else if (formNames.some(formName => isAccountHolderNameAndLegalNameMatch(formName, legalName))) {
    return null;
  }

  const formattedFormNames = formNames.map(formName => `"${formName}"`).join(' / ');
  return `The name on the legal document (${formattedFormNames}) does not match the ${nameLabel} ("${legalName}").`;
};

/**
 * Compares the address submitted in the legal document to the payee address, at the city and postal code
 * level (same granularity as the payout method address check). Returns the details when it does not match.
 */
export const getLegalDocumentAddressMismatchDetails = (
  identity: LegalDocumentIdentity | null | undefined,
  payeeAddress?: AddressComparisonInput | null,
  payeeCountry?: string | null,
  { counterpartyLabel = 'payee' }: { counterpartyLabel?: string } = {},
): string | null => {
  if (!identity || !payeeAddress) {
    return null;
  }

  const isMismatch =
    isDefinedButNotEqual(identity.address.city, payeeAddress.city) ||
    isDefinedButNotEqual(identity.address.postalCode, payeeAddress.postalCode);
  if (!isMismatch) {
    return null;
  }

  const formAddress = formatAddressForDetails(identity.address, identity.country);
  const accountAddress = formatAddressForDetails(payeeAddress, payeeCountry || payeeAddress.country);
  return `The legal document lists "${formAddress}", while the ${counterpartyLabel} is registered at "${accountAddress}".`;
};

/**
 * Compares the country submitted in the legal document to the payee country (never `data.taxableCountry`,
 * which is derived from the form itself). Returns the details when it does not match.
 */
export const getLegalDocumentCountryMismatchDetails = (
  identity: LegalDocumentIdentity | null | undefined,
  payeeCountry?: string | null,
  { counterpartyLabel = 'payee' }: { counterpartyLabel?: string } = {},
): string | null => {
  const formCountry = normalizeCountryToISO(identity?.country);
  const accountCountry = normalizeCountryToISO(payeeCountry);
  if (!formCountry || !accountCountry || formCountry === accountCountry) {
    return null;
  }

  return `The legal document lists the country "${formCountry}", while the ${counterpartyLabel} is registered in "${accountCountry}".`;
};
