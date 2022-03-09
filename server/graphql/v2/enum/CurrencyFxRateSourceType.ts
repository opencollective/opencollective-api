import { GraphQLEnumType } from 'graphql';

export enum CurrencyFxRateSourceTypeEnum {
  OPENCOLLECTIVE = 'OPENCOLLECTIVE',
  PAYPAL = 'PAYPAL',
  WISE = 'WISE',
}

export const CurrencyFxRateSourceType = new GraphQLEnumType({
  name: 'CurrencyFxRateSourceType',
  description: 'Where does the FX rate come from',
  values: {
    [CurrencyFxRateSourceTypeEnum.OPENCOLLECTIVE]: {
      value: CurrencyFxRateSourceTypeEnum.OPENCOLLECTIVE,
      description: 'Open Collective internal system, relying on caching and 3rd party APIs',
    },
    [CurrencyFxRateSourceTypeEnum.PAYPAL]: {
      value: CurrencyFxRateSourceTypeEnum.PAYPAL,
      description: 'PayPal API',
    },
    [CurrencyFxRateSourceTypeEnum.WISE]: {
      value: CurrencyFxRateSourceTypeEnum.WISE,
      description: 'Wise API',
    },
  },
});
