import { CountryCode, formatAddress as libFormatAddress } from 'lib-address';

import { Location } from '../types/Location';

import { reportErrorToSentry } from './sentry';

type Options = {
  includeCountry?: boolean;
  lineDivider?: ', ' | '\n';
  locale?: string;
};

export async function formatAddress(
  { country, structured }: Location,
  { includeCountry = false, lineDivider = ', ', locale = 'en' }: Options = {},
): Promise<string> {
  if (!structured) {
    return null;
  }

  const { address1, address2, city, zone, postalCode } = structured;

  try {
    const formatted = libFormatAddress(
      {
        country: country as CountryCode,
        addressLine1: address1,
        addressLine2: address2,
        city,
        state: zone,
        zip: postalCode,
      },
      {
        appendCountry: includeCountry,
        lang: locale,
        preserveCase: true,
      },
    );

    // lib-address returns newline-separated string, convert to requested divider
    if (lineDivider === '\n') {
      return formatted;
    } else {
      return formatted.split('\n').filter(Boolean).join(lineDivider);
    }
  } catch (error) {
    reportErrorToSentry(error);

    // Use fallback formatting (US format)
    return [address1, address2, [city, zone, postalCode].filter(Boolean).join(' ')].filter(Boolean).join(lineDivider);
  }
}
