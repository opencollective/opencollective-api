import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import moment from 'moment';

import PlatformSubscription, {
  BillingMonth,
  BillingPeriod,
  UtilizationType,
} from '../../../models/PlatformSubscription';

import { GraphQLPlatformSubscriptionTier } from './PlatformSubscriptionTier';

export const GraphQLPlatformSubscription = new GraphQLObjectType({
  name: 'PlatformSubscription',
  fields: () => ({
    startDate: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Start date (inclusive)',
    },
    endDate: {
      type: GraphQLDateTime,
      description: 'End date (inclusive), null if not set',
    },
    isCurrent: {
      type: new GraphQLNonNull(GraphQLBoolean),
    },
    plan: { type: new GraphQLNonNull(GraphQLPlatformSubscriptionTier) },
    utilization: {
      args: {
        billingPeriod: {
          type: GraphQLPlatformBillingPeriodInput,
        },
      },
      type: new GraphQLNonNull(GraphQLPlatformSubscriptionUtilization),
      async resolve(platformSubscription: PlatformSubscription, args) {
        const billingPeriod = platformSubscription.getQueryBillingPeriod() ?? {
          year: moment.utc().year(),
          month: moment.utc().month() + 1,
        };

        if (args.billingPeriod) {
          billingPeriod.year = args.billingPeriod.year;
          billingPeriod.month = args.billingPeriod.month;
        }

        return platformSubscription.calculateUtilization(billingPeriod);
      },
    },
  }),
});

export const GraphQLPlatformBilling = new GraphQLObjectType({
  name: 'PlatformBilling',
  fields: () => ({
    billingPeriod: {
      type: new GraphQLNonNull(GraphQLPlatformBillingPeriod),
    },
    subscriptions: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPlatformSubscription))),
    },
  }),
});

export const GraphQLPlatformBillingPeriodInput = new GraphQLInputObjectType({
  name: 'PlatformBillingPeriodInput',
  fields: () => ({
    year: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    month: {
      type: new GraphQLNonNull(GraphQLPlatformBillingMonth),
    },
  }),
});

const GraphQLPlatformBillingPeriod = new GraphQLObjectType({
  name: 'PlatformBillingPeriod',
  fields: () => ({
    year: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    month: {
      type: new GraphQLNonNull(GraphQLPlatformBillingMonth),
    },
    startDate: {
      type: new GraphQLNonNull(GraphQLDateTime),
      resolve(billingPeriod: BillingPeriod) {
        return PlatformSubscription.periodStartDate(PlatformSubscription.getBillingPeriodRange(billingPeriod));
      },
    },
    endDate: {
      type: new GraphQLNonNull(GraphQLDateTime),
      resolve(billingPeriod: BillingPeriod) {
        return PlatformSubscription.periodEndDate(PlatformSubscription.getBillingPeriodRange(billingPeriod));
      },
    },
    isCurrent: {
      type: new GraphQLNonNull(GraphQLBoolean),
      resolve(billingPeriod: BillingPeriod) {
        const period = PlatformSubscription.getBillingPeriodRange(billingPeriod);
        const now = moment.utc();
        return (
          now.isSameOrAfter(PlatformSubscription.periodStartDate(period)) &&
          now.isSameOrBefore(PlatformSubscription.periodEndDate(period))
        );
      },
    },
  }),
});

const GraphQLPlatformBillingMonth = new GraphQLEnumType({
  name: 'PlatformBillingMonth',
  values: () => ({
    ...Object.keys(BillingMonth)
      .filter(k => isNaN(Number(k)))
      .reduce(
        (acc, billingMonth) => ({
          ...acc,
          [billingMonth]: {
            value: BillingMonth[billingMonth],
          },
        }),
        {},
      ),
  }),
});

const GraphQLPlatformSubscriptionUtilization = new GraphQLObjectType({
  name: 'PlatformSubscriptionUtilization',
  fields: () => ({
    billingPeriod: {
      type: new GraphQLNonNull(GraphQLPlatformBillingPeriod),
    },
    startDate: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    endDate: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    ...Object.values(UtilizationType).reduce(
      (acc, utilizationType) => ({
        ...acc,
        [utilizationType]: {
          type: new GraphQLNonNull(GraphQLInt),
        },
      }),
      {},
    ),
  }),
});
