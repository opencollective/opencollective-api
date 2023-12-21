import { GraphQLFloat, GraphQLInputObjectType, GraphQLInt } from 'graphql';
import { isNil } from 'lodash';

import { floatAmountToCents } from '../../../lib/math';
import { GraphQLCurrency } from '../enum/Currency';

import GraphQLCurrencyExchangeRateInput from './CurrencyExchangeRateInput';

export type AmountInputType = {
  value?: number;
  currency?: string;
  valueInCents?: number;
};

export const GraphQLAmountInput = new GraphQLInputObjectType({
  name: 'AmountInput',
  description: 'Input type for an amount with the value and currency',
  fields: () => ({
    value: {
      type: GraphQLFloat,
      description: 'The value in plain',
    },
    currency: {
      type: GraphQLCurrency,
      description: 'The currency string',
    },
    valueInCents: {
      type: GraphQLInt,
      description: 'The value in cents',
    },
    exchangeRate: {
      type: GraphQLCurrencyExchangeRateInput,
      description:
        'If the amount was generated from a currency conversion, this field can be used to provide details about the conversion',
    },
  }),
});

export const getValueInCentsFromAmountInput = (
  input,
  { expectedCurrency = null, allowNilCurrency = true }: { expectedCurrency?: string; allowNilCurrency?: boolean } = {},
) => {
  if (expectedCurrency) {
    assertAmountInputCurrency(input, expectedCurrency, { allowNil: allowNilCurrency });
  }

  if (!isNil(input.valueInCents)) {
    return input.valueInCents;
  } else if (!isNil(input.value)) {
    return floatAmountToCents(input.value);
  } else {
    throw new Error('You must either set a `value` or a `valueInCents` when submitting an AmountInput');
  }
};

export const assertAmountInputCurrency = (input, expectedCurrency, { allowNil = true, name = null } = {}) => {
  if (allowNil && !input.currency) {
    return;
  } else if (input.currency !== expectedCurrency) {
    throw new Error(
      `Expected currency${name ? ` for ${name} ` : ' '}to be ${expectedCurrency} but was ${input.currency}`,
    );
  }
};
