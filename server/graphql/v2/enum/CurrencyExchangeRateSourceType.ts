import { GraphQLEnumType } from 'graphql';

export enum CurrencyExchangeRateSourceTypeEnum {
  OPENCOLLECTIVE = 'OPENCOLLECTIVE',
  PAYPAL = 'PAYPAL',
  WISE = 'WISE',
}

export const GraphQLCurrencyExchangeRateSourceType = new GraphQLEnumType({
  name: 'CurrencyExchangeRateSourceType',
  description: 'Where does the FX rate come from',
  values: {
    [CurrencyExchangeRateSourceTypeEnum.OPENCOLLECTIVE]: {
      value: CurrencyExchangeRateSourceTypeEnum.OPENCOLLECTIVE,
      description: 'Open Collective internal system, relying on caching and 3rd party APIs',
    },
    [CurrencyExchangeRateSourceTypeEnum.PAYPAL]: {
      value: CurrencyExchangeRateSourceTypeEnum.PAYPAL,
      description: 'PayPal API',
    },
    [CurrencyExchangeRateSourceTypeEnum.WISE]: {
      value: CurrencyExchangeRateSourceTypeEnum.WISE,
      description: 'Wise API',
    },
  },
});
