import { GraphQLEnumType } from 'graphql';

/**
 * Units for grouping entries in a time series.
 * Based on https://www.postgresql.org/docs/9.1/functions-datetime.html#FUNCTIONS-DATETIME-TRUNC.
 */
export const TimeUnit = new GraphQLEnumType({
  name: 'TimeUnit',
  values: {
    SECOND: {},
    MINUTE: {},
    HOUR: {},
    DAY: {},
    WEEK: {},
    MONTH: {},
    YEAR: {},
  },
});
