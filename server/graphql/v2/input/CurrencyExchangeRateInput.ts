import { GraphQLFloat, GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { ExpenseItem } from '../../../models';
import { GraphQLCurrency } from '../enum';
import { GraphQLCurrencyExchangeRateSourceType } from '../enum/CurrencyExchangeRateSourceType';

export type GraphQLCurrencyExchangeRateInputType = {
  source: ExpenseItem['fxRateSource'];
  fromCurrency: string;
  toCurrency: string;
  date: string;
  value: number;
};

const GraphQLCurrencyExchangeRateInput = new GraphQLInputObjectType({
  name: 'CurrencyExchangeRateInput',
  description: 'Fields for a currency exchange rate',
  fields: (): Record<keyof GraphQLCurrencyExchangeRateInputType, GraphQLInputFieldConfig> => ({
    source: {
      type: new GraphQLNonNull(GraphQLCurrencyExchangeRateSourceType),
      description: 'Where does the FX rate comes from',
    },
    fromCurrency: {
      type: new GraphQLNonNull(GraphQLCurrency),
    },
    toCurrency: {
      type: new GraphQLNonNull(GraphQLCurrency),
    },
    date: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Date of the FX rate',
    },
    value: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Exchange rate value as a float (e.g 1.15 or 0.86)',
    },
  }),
});

export default GraphQLCurrencyExchangeRateInput;
