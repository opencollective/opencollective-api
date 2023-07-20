import { GraphQLEnumType } from 'graphql';

import { ExpenseFeesPayer } from '../../../constants/expense-fees-payer.js';

export const GraphQLFeesPayer = new GraphQLEnumType({
  name: 'FeesPayer',
  description: 'All supported expense types',
  values: {
    [ExpenseFeesPayer.COLLECTIVE]: {
      description: 'The collective will be responsible for paying the fees',
    },
    [ExpenseFeesPayer.PAYEE]: {
      description: "The payee will be responsible for paying the fees (they'll be deduced from the total amount)",
    },
  },
});
