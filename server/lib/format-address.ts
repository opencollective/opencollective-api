import { Location } from '../types/Location';

import { AddressValidationError, CountryCode, formatAddress as libFormatAddress } from './address';
import { normalizeZoneCode } from './normalize-zone';
import { reportErrorToSentry } from './sentry';

type Options = {
  includeCountry?: boolean;
  lineDivider?: ', ' | '\n';
};

export async function formatAddress(
  { country, structured }: Location,
  { includeCountry = false, lineDivider = ', ' }: Options = {},
): Promise<string> {
  if (!structured) {
    return null;
  }

  const { address1, address2, city, zone, postalCode } = structured;
  const normalizedZone = normalizeZoneCode(country, zone);

  try {
    const formatted = libFormatAddress(
      {
        country: country as CountryCode,
        addressLine1: address1,
        addressLine2: address2,
        city,
        state: normalizedZone,
        zip: postalCode,
      },
      { appendCountry: includeCountry },
    );

    // The address lib returns a newline-separated string, convert to requested divider
    if (lineDivider === '\n') {
      return formatted;
    } else {
      return formatted.split('\n').filter(Boolean).join(lineDivider);
    }
  } catch (error) {
    // Addresses are not validated on input, so not matching the country's rules (e.g. a zip in an unexpected format or
    // a missing state) is expected and not worth reporting
    if (!(error instanceof AddressValidationError)) {
      reportErrorToSentry(error);
    }

    // Use fallback formatting (US format)
    return [address1, address2, [city, normalizedZone, postalCode].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(lineDivider);
  }
}
