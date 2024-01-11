import { randAmount, randNumber } from './fake-data';

// ignore unused exports fakeGraphQLExchangeRateInput

export const fakeGraphQLExchangeRateInput = (values = {}) => {
  return {
    source: 'WISE',
    fromCurrency: 'EUR',
    toCurrency: 'USD',
    value: randNumber(0.01, 2),
    date: '2020-01-01T00:00:00Z',
    ...values,
  };
};

export const fakeGraphQLAmountInput = (values = {}) => {
  return {
    value: randAmount(),
    currency: 'USD',
    ...values,
    exchangeRate: values['exchangeRate'] ? fakeGraphQLExchangeRateInput(values['exchangeRate']) : null,
  };
};
