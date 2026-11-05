/**
 * Address formatting and validation based on Google's address metadata (libaddressinput).
 *
 * This is a trimmed port of lib-address 0.7.0 (https://github.com/LancelotP/lib-address, MIT, see LICENSE in this
 * directory), limited to what we use. The data in `countries.json` is regenerated with
 * `scripts/update-address-metadata.ts`.
 */

import data from './countries.json';

export type CountryCode = keyof typeof data.countries;

type SubRegionData = {
  key: string;
  /** Local name. Translations are not kept, see `scripts/update-address-metadata.ts` */
  name: string;
  /** Latin transliteration of `name`, when it differs */
  latin?: string;
  /** Prefix (regex) that zip codes in this sub-region start with */
  zip?: string;
};

type CountryData = {
  name: string;
  fmt?: string;
  require?: string;
  zip?: string;
  sub_regions?: SubRegionData[];
};

const countries = new Map<string, CountryData>(Object.entries(data.countries));

const defaultCountryData = { fmt: '%N%n%O%n%A%n%C', require: 'AC' };

const getCountryData = (countryCode: string): CountryData => {
  const countryData = countries.get(countryCode);
  if (!countryData) {
    throw new Error(`Data for ${countryCode} is missing`);
  }

  return { ...defaultCountryData, ...countryData };
};

type Address = {
  country: CountryCode;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  /** Sub-region (state, province, etc.) code */
  state?: string;
  zip?: string;
};

/** Fields that can be marked as required in the `require` string of a country (same order as lib-address) */
const REQUIRABLE_FIELDS = {
  S: 'state',
  Z: 'zip',
  D: 'dependentLocality',
  C: 'city',
  X: 'sortingCode',
  A: 'addressLine1',
} as const;

/**
 * Throws if the address is missing a required field, has a zip that doesn't match the country's (or sub-region's)
 * format, or has an unknown state in a country where the state is required.
 */
const validateAddress = (address: Address): void => {
  const countryData = getCountryData(address.country);
  const errors: string[] = [];

  for (const [abbr, field] of Object.entries(REQUIRABLE_FIELDS)) {
    if (countryData.require.includes(abbr) && !(address as Record<string, string>)[field]?.trim()) {
      errors.push(`Field ${field} is required`);
    }
  }

  if (countryData.zip) {
    const regex = new RegExp(`^${countryData.zip}$`);
    const subRegion = address.state ? countryData.sub_regions?.find(sr => sr.key === address.state) : null;
    const zip = address.zip?.trim() ?? '';
    if (!regex.test(zip)) {
      errors.push(`Zip format invalid. Expected: /${regex.source}/`);
    }
    if (subRegion?.zip) {
      const subRegionRegex = new RegExp(`^${subRegion.zip}`);
      if (!subRegionRegex.test(zip)) {
        errors.push(`Zip format invalid. Expected: /${regex.source}/ and /${subRegionRegex.source}/`);
      }
    }
  }

  if (countryData.require.includes('S') && !countryData.sub_regions?.find(sr => sr.key === address.state)) {
    errors.push(`State invalid for country: ${address.country}`);
  }

  if (errors.length) {
    throw new Error(`Address validation failed: ${errors.join(', ')}`);
  }
};

/**
 * Formats an address following the country's conventions, one line per `\n`. The casing of the input is preserved
 * and the state code is replaced by its local name.
 *
 * @throws if the address is not valid for the country (see `validateAddress`)
 */
export const formatAddress = (
  address: Address,
  { appendCountry = false }: { appendCountry?: boolean } = {},
): string => {
  validateAddress(address);

  const countryData = getCountryData(address.country);
  const stateData = address.state ? countryData.sub_regions?.find(sr => sr.key === address.state) : null;
  const {
    addressLine1 = '',
    addressLine2 = '',
    city = '',
    state = '',
    zip = '',
  } = {
    ...address,
    state: stateData ? stateData.name : address.state,
  };
  const addressLine = [addressLine1, addressLine2].filter(Boolean).join('\n');

  // Same replacement chain as lib-address, including its quirks (string replacements, `null` values not defaulted)
  const nationalFormat = countryData.fmt
    .replace(/%N/g, '')
    .replace(/%O/g, '')
    .replace(/%A/g, addressLine)
    .replace(/%D/g, '')
    .replace(/%C/g, city)
    .replace(/%S/g, state)
    .replace(/%Z/g, zip)
    .replace(/%X/g, '')
    .replace(/(%n)+/g, '\n')
    .trim();

  return appendCountry ? `${nationalFormat}\n${countryData.name}` : nationalFormat;
};

/**
 * Lists the first-level subdivisions (states, provinces, etc.) of a country.
 * Labels use the local name, or the latin transliteration when `useLatin` is set and one exists.
 *
 * @throws if the country is unknown
 */
export const getCountrySubdivisions = (
  country: CountryCode,
  { useLatin = false }: { useLatin?: boolean } = {},
): { value: string; label: string }[] => {
  return (
    getCountryData(country).sub_regions?.map(sr => ({
      value: sr.key,
      label: (useLatin && sr.latin) || sr.name,
    })) ?? []
  );
};

/** Case-insensitive check that `value` is the code of a first-level subdivision of `country` */
export const isValidCountrySubdivisionCode = (country: CountryCode, value: string): boolean => {
  const sanitizedValue = value.toUpperCase().trim();
  const sanitizedCountry = country.toUpperCase().trim();
  if (!sanitizedValue || !countries.has(sanitizedCountry)) {
    return false;
  }

  return Boolean(getCountryData(sanitizedCountry).sub_regions?.find(sr => sr.key === sanitizedValue));
};
