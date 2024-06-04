import { GraphQLEnumType } from 'graphql';

export type TimeUnit = 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

/**
 * Units for grouping entries in a time series.
 * Based on https://www.postgresql.org/docs/9.1/functions-datetime.html#FUNCTIONS-DATETIME-TRUNC.
 */
export const GraphQLTimeUnit = new GraphQLEnumType({
  name: 'TimeUnit',
  values: {
    SECOND: {},
    MINUTE: {},
    HOUR: {},
    DAY: {},
    WEEK: {},
    MONTH: {},
    QUARTER: {},
    YEAR: {},
  },
});
