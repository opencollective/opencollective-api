import { GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { TimeUnit } from '../enum/TimeUnit';

export const getTimeSeriesFields = () => ({
  startDate: {
    type: new GraphQLNonNull(GraphQLDateTime),
    description: 'The start date of the time series',
  },
  endDate: {
    type: new GraphQLNonNull(GraphQLDateTime),
    description: 'The end date of the time series',
  },
  timeUnit: {
    type: new GraphQLNonNull(TimeUnit),
    description: 'The interval between two data points',
  },
});

export const TimeSeries = new GraphQLInterfaceType({
  name: 'TimeSeries',
  fields: getTimeSeriesFields,
});
