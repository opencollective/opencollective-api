/*
 * Supported Currencies by PayPal for use with payments and as currency balances.
 * Reference: https://developer.paypal.com/docs/reports/reference/paypal-supported-currencies/
 *
 * Rmember to keep this in sync with `opencollective-frontend/lib/constants/currency.ts`.
 */
export const PayPalSupportedCurrencies = [
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MYR',
  'MXN',
  'TWD',
  'NZD',
  'NOK',
  'PHP',
  'PLN',
  'GBP',
  'SGD',
  'SEK',
  'CHF',
  'THB',
  'USD',
] as const;
