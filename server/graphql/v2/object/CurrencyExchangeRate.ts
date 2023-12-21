import { GraphQLBoolean, GraphQLFieldConfig, GraphQLFloat, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { ExpenseItem } from '../../../models';
import { FX_RATE_SOURCE } from '../../../models/CurrencyExchangeRate';
import { GraphQLCurrency } from '../enum';
import { GraphQLCurrencyExchangeRateSourceType } from '../enum/CurrencyExchangeRateSourceType';

export type GraphQLCurrencyExchangeRateFields = {
  value: number;
  source: FX_RATE_SOURCE | `${FX_RATE_SOURCE}`;
  fromCurrency: string;
  toCurrency: string;
  date: Date;
  isApproximate: boolean;
};

const GraphQLCurrencyExchangeRate = new GraphQLObjectType({
  name: 'CurrencyExchangeRate',
  description: 'Fields for a currency fx rate',
  fields: (): Record<keyof GraphQLCurrencyExchangeRateFields, GraphQLFieldConfig<ExpenseItem, any>> => ({
    value: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Exchange rate value as a scalar (e.g 1.15 or 0.86)',
    },
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
    isApproximate: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Is the FX rate approximate or a fixed value?',
    },
  }),
});

export default GraphQLCurrencyExchangeRate;
