import { GraphQLEnumType } from 'graphql';

export const GraphQLAveragePeriod = new GraphQLEnumType({
  name: 'AveragePeriod',
  description: 'The period over which the average is calculated',
  values: {
    YEAR: {
      value: 'year',
    },
    MONTH: {
      value: 'month',
    },
  },
});
