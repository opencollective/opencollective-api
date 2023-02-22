import { GraphQLEnumType } from 'graphql';
import { mapValues } from 'lodash';

import { SupportedCurrencies, TransferWiseCurrencies } from '../../../constants/currencies';

const convertToEnumType = a => mapValues(a, description => ({ description }));

export const GraphQLCurrency = new GraphQLEnumType({
  name: 'Currency',
  description: 'All supported currencies',
  values: convertToEnumType(SupportedCurrencies),
});

export const GraphQLTransferWiseCurrency = new GraphQLEnumType({
  name: 'TransferWiseCurrency',
  description: 'All currencies supported by TransferWise',
  values: convertToEnumType(TransferWiseCurrencies),
});
