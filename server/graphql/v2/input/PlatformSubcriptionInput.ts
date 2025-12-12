import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';

import { CommercialFeatures } from '../../../constants/feature';
import { GraphQLAmountInput } from '../input/AmountInput';

const GraphQLPlatformSubscriptionFeaturesInput = new GraphQLInputObjectType({
  name: 'PlatformSubscriptionFeaturesFeatures',
  fields: () => ({
    ...CommercialFeatures.reduce(
      (acc, feature) => ({
        ...acc,
        [feature]: {
          type: new GraphQLNonNull(GraphQLBoolean),
        },
      }),
      {},
    ),
  }),
});

const GraphQLPlatformSubscriptionPlanInput = new GraphQLInputObjectType({
  name: 'PlatformSubscriptionPlanInput',
  fields: {
    title: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The title of the subscription plan',
    },
    type: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The type of the subscription plan (e.g., "basic", "premium")',
    },
    basePlanId: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The ID of the base plan for this subscription tier',
    },
    features: {
      type: GraphQLPlatformSubscriptionFeaturesInput,
      description: 'Features included in this subscription plan',
    },
    pricing: {
      type: new GraphQLNonNull(
        new GraphQLInputObjectType({
          name: 'PlatformSubscriptionPlanPricing',
          fields: {
            pricePerMonth: {
              type: new GraphQLNonNull(GraphQLAmountInput),
              description: 'The price of the subscription plan per month',
            },
            pricePerAdditionalCollective: {
              type: new GraphQLNonNull(GraphQLAmountInput),
              description: 'Price for each additional collective beyond the included limit',
            },
            pricePerAdditionalExpense: {
              type: new GraphQLNonNull(GraphQLAmountInput),
              description: 'Price for each additional expense beyond the included limit',
            },
            includedCollectives: {
              type: new GraphQLNonNull(GraphQLInt),
              description: 'Number of collectives included in this subscription plan',
            },
            includedExpensesPerMonth: {
              type: new GraphQLNonNull(GraphQLInt),
              description: 'Number of expenses included in this subscription plan per month',
            },
          },
        }),
      ),
      description: 'Pricing details for the subscription plan',
    },
  },
});

export const GraphQLPlatformSubscriptionInput = new GraphQLInputObjectType({
  name: 'PlatformSubscriptionInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'The ID of the platform subscription to update',
    },
    plan: {
      type: new GraphQLNonNull(GraphQLPlatformSubscriptionPlanInput),
      description: 'The new platform subscription plan to apply to the account',
    },
  },
});
