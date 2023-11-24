/**
 * Describes an exchange rate between two currencies. Safe to pass to the `CurrencyExchangeRate` GraphQL type.
 */
export type CurrencyExchangeRateType = {
  value: number;
  source: 'OPENCOLLECTIVE' | 'PAYPAL' | 'WISE' | 'USER';
  fromCurrency: string;
  toCurrency: string;
  date: Date;
  isApproximate: boolean;
};

/**
 * Describes an amount in a way that can safely be passed to the `Amount` GraphQL type.
 * The amount in cents needs to be set on `value`
 */
export type AmountWithExchangeRate = {
  value: number;
  currency: string;
  exchangeRate?: CurrencyExchangeRateType;
};
