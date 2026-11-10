import { Location } from '../types/Location';

import {
  AddressValidationError,
  AddressValidationIssue,
  CountryCode,
  formatAddress as libFormatAddress,
  getAddressValidationIssues,
} from './address';
import { normalizeZoneCode } from './normalize-zone';
import { reportErrorToSentry } from './sentry';

type Options = {
  includeCountry?: boolean;
  lineDivider?: ', ' | '\n';
};

const getLibAddressFromLocation = ({ country, structured }: Location) => {
  const { address1, address2, city, zone, postalCode } = structured;
  return {
    country: country as CountryCode,
    addressLine1: address1,
    addressLine2: address2,
    city,
    state: normalizeZoneCode(country, zone),
    zip: postalCode,
  };
};

/**
 * Returns the problems of a structured location for its country. Returns an empty list when there is no structured
 * address or no country to validate against.
 *
 * @param ignoreMissingFields only report values that were provided but are invalid (e.g. a malformed postal code)
 */
export function getLocationValidationIssues(
  location: Location,
  { ignoreMissingFields = false }: { ignoreMissingFields?: boolean } = {},
): AddressValidationIssue[] {
  if (!location?.structured || !location.country) {
    return [];
  }

  try {
    return getAddressValidationIssues(getLibAddressFromLocation(location), { ignoreMissingFields });
  } catch {
    // Unknown country: nothing we can validate against
    return [];
  }
}

export async function formatAddress(
  { country, structured }: Location,
  { includeCountry = false, lineDivider = ', ' }: Options = {},
): Promise<string> {
  if (!structured) {
    return null;
  }

  const libAddress = getLibAddressFromLocation({ country, structured });
  const { addressLine1: address1, addressLine2: address2, city, state: normalizedZone, zip: postalCode } = libAddress;

  try {
    const formatted = libFormatAddress(libAddress, { appendCountry: includeCountry });

    // The address lib returns a newline-separated string, convert to requested divider
    if (lineDivider === '\n') {
      return formatted;
    } else {
      return formatted.split('\n').filter(Boolean).join(lineDivider);
    }
  } catch (error) {
    reportErrorToSentry(error, {
      extra: {
        country,
        zone: normalizedZone,
        providedFields: Object.entries(structured)
          .filter(([, value]) => Boolean(value))
          .map(([key]) => key),
        validationIssues: error instanceof AddressValidationError ? error.issues : undefined,
      },
    });

    // Use fallback formatting (US format)
    return [address1, address2, [city, normalizedZone, postalCode].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(lineDivider);
  }
}
