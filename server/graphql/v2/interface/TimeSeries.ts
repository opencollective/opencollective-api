import { GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLTimeUnit } from '../enum/TimeUnit';

export const getTimeSeriesFields = () => ({
  dateFrom: {
    type: GraphQLDateTime,
    description: 'The start date of the time series',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'The end date of the time series',
  },
  timeUnit: {
    type: new GraphQLNonNull(GraphQLTimeUnit),
    description: 'The interval between two data points',
  },
});

export const GraphQLTimeSeries = new GraphQLInterfaceType({
  name: 'TimeSeries',
  fields: getTimeSeriesFields,
});
