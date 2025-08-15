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

import { Expense } from '../../../models';
import { ExpenseType } from '../../../models/Expense';
import PlatformSubscription, {
  Billing,
  BillingMonth,
  BillingPeriod,
  UtilizationType,
} from '../../../models/PlatformSubscription';

import { GraphQLAmount } from './Amount';
import { GraphQLExpense } from './Expense';
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
    utilization: {
      type: new GraphQLNonNull(GraphQLPlatformUtilization),
    },
    dueDate: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    baseAmount: {
      type: new GraphQLNonNull(GraphQLAmount),
      resolve(billing: Billing) {
        return { value: billing.baseAmount ?? 0, currency: 'USD' };
      },
    },
    additional: {
      type: new GraphQLNonNull(GraphQLPlatformBillingAdditional),
      resolve(billing: Billing) {
        return {
          utilization: billing.additional.utilization,
          amounts: Object.fromEntries(
            Object.entries(billing.additional.amounts).map(([utilizationType, value]) => [
              utilizationType,
              {
                value: value ?? 0,
                currency: 'USD',
              },
            ]),
          ),
          total: { value: billing.additional.total ?? 0, currency: 'USD' },
        };
      },
    },
    totalAmount: {
      type: new GraphQLNonNull(GraphQLAmount),
      resolve(billing: Billing) {
        return { value: billing.totalAmount ?? 0, currency: 'USD' };
      },
    },
    expenses: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLExpense))),
      resolve(billing: Billing) {
        return Expense.findAll({
          where: {
            CollectiveId: billing.collectiveId,
            type: ExpenseType.PLATFORM_BILLING,
          },
        });
      },
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

const GraphQLPlatformUtilization = new GraphQLObjectType({
  name: 'PlatformUtilization',
  fields: () => ({
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

const GraphQLPlatformBillingAdditional = new GraphQLObjectType({
  name: 'PlatformBillingAdditional',
  fields: () => ({
    total: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    amounts: {
      type: new GraphQLObjectType({
        name: 'PlatformBillingAdditionalUtilizationCharges',
        fields: () => ({
          ...Object.values(UtilizationType).reduce(
            (acc, utilizationType) => ({
              ...acc,
              [utilizationType]: {
                type: new GraphQLNonNull(GraphQLAmount),
              },
            }),
            {},
          ),
        }),
      }),
    },
    utilization: {
      type: new GraphQLNonNull(GraphQLPlatformUtilization),
    },
  }),
});
