import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import moment from 'moment';

import { getTimeSeriesFields, TimeSeries } from '../interface/TimeSeries';

import { Amount } from './Amount';

export const getNumberOfDays = (startDate, endDate, collective) => {
  return Math.abs(moment(startDate || collective.createdAt).diff(moment(endDate), 'days'));
};

export const getTimeUnit = numberOfDays => {
  if (numberOfDays < 21) {
    return 'DAY'; // Up to 3 weeks
  } else if (numberOfDays < 90) {
    return 'WEEK'; // Up to 3 months
  } else if (numberOfDays < 365 * 3) {
    return 'MONTH'; // Up to 3 years
  } else {
    return 'YEAR';
  }
};

const TimeSeriesAmountNodes = new GraphQLObjectType({
  name: 'TimeSeriesAmountNode',
  fields: () => ({
    date: { type: new GraphQLNonNull(GraphQLDateTime) },
    amount: { type: new GraphQLNonNull(Amount) },
    label: { type: GraphQLString },
  }),
});

export const TimeSeriesAmount = new GraphQLObjectType({
  name: 'TimeSeriesAmount',
  description: 'Amount time series',
  interfaces: [TimeSeries],
  fields: () => ({
    ...getTimeSeriesFields(),
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TimeSeriesAmountNodes))),
      description: 'Time series data points',
    },
  }),
});
