import { GraphQLEnumType } from 'graphql';

import intervals from '../../../constants/intervals';

export const OrderFrequency = new GraphQLEnumType({
  name: 'OrderFrequency',
  values: {
    MONTHLY: {},
    YEARLY: {},
    ONETIME: {},
  },
});

/**
 * From an order frequency provided as `OrderFrequency` GQLV2 enum, returns an interval
 * as we use it in the DB (ie. MONTHLY => month)
 */
export const getIntervalFromOrderFrequency = input => {
  switch (input) {
    case 'MONTHLY':
      return intervals.MONTH;
    case 'YEARLY':
      return intervals.YEAR;
    default:
      return null;
  }
};
