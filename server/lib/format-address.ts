import AddressFormatter, { formatAddress as shopifyFormatAddress } from '@shopify/address';

import { Location } from '../types/Location';

type Options = {
  includeCountry?: boolean;
  lineDivider?: 'comma' | 'newline';
  locale?: string;
};

export async function formatAddress(
  { address1, address2, city, postalCode, zone, country }: Location,
  { includeCountry = false, lineDivider = 'comma', locale = 'en' }: Options = {},
): Promise<string> {
  let addressLines: string[];

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
    console.log('Error formatting address using @shopify/address:', error.message);

    // Use fallback formatting (US format)
    addressLines = [address1, address2, [city, zone, postalCode].filter(Boolean).join(' ')];
  }

  return addressLines.filter(Boolean).join(lineDivider === 'comma' ? ', ' : '\n');
}
