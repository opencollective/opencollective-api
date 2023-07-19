import AddressFormatter, { formatAddress as shopifyFormatAddress } from '@shopify/address/index.mjs';

import { Location } from '../types/Location.js';

import { reportErrorToSentry } from './sentry.js';

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
  let addressLines: string[];
  const { address1, address2, city, zone, postalCode } = structured;
  /** A few countries (see list in frontend/components/I18nAddressFields.js)
   * are present in the input type, but not available in the @shopify/address formatter.
   *
   * All except Antartica (AQ) are US territories and use the US address format.
   * The US format is provided as a fallback which does not rely on the Shopify API,
   * since this can also fail to respond to the getCountry request
   */
  try {
    // Locale is only affecting language, not formatting
    const addressFormatter = new AddressFormatter(locale);
    const formattingCountry = await addressFormatter.getCountry(country);
    addressLines = shopifyFormatAddress(
      {
        address1,
        address2,
        city,
        province: zone,
        zip: postalCode,
        ...(includeCountry && {
          country,
        }),
      },
      formattingCountry,
    );
  } catch (error) {
    reportErrorToSentry(error);

    // Use fallback formatting (US format)
    addressLines = [address1, address2, [city, zone, postalCode].filter(Boolean).join(' ')];
  }

  return addressLines.filter(Boolean).join(lineDivider);
}
