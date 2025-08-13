import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { CommercialFeatures, CommercialFeaturesType } from '../../../constants/feature';
import { PlatformSubscriptionTiers } from '../../../constants/plans';

import { GraphQLAmount } from './Amount';

export const GraphQLPlatformSubscriptionTier = new GraphQLObjectType({
  name: 'PlatformSubscriptionTier',
  description: 'Type for Platform Subscription Tier',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The title of the subscription tier',
    },
    title: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The title of the subscription tier',
    },
    type: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The type of the subscription tier (e.g., "basic", "premium")',
    },
    basePlanId: {
      type: GraphQLString,
      description: 'The ID of the base plan for this subscription tier',
    },
    pricing: {
      type: new GraphQLNonNull(
        new GraphQLObjectType({
          name: 'PlatformSubscriptionTierPricing',
          fields: {
            pricePerMonth: {
              type: new GraphQLNonNull(GraphQLAmount),
              description: 'The price of the subscription tier per month',
              resolve: pricing => {
                return { value: pricing.pricePerMonth, currency: 'USD' };
              },
            },
            pricePerAdditionalCollective: {
              type: new GraphQLNonNull(GraphQLAmount),
              description: 'Price for each additional collective beyond the included limit',
              resolve: pricing => {
                return { value: pricing.pricePerAdditionalCollective, currency: 'USD' };
              },
            },
            pricePerAdditionalExpense: {
              type: new GraphQLNonNull(GraphQLAmount),
              description: 'Price for each additional expense beyond the included limit',
              resolve: pricing => {
                return { value: pricing.pricePerAdditionalExpense, currency: 'USD' };
              },
            },
            includedCollectives: {
              type: new GraphQLNonNull(GraphQLInt),
              description: 'Number of collectives included in this subscription tier',
            },
            includedExpensesPerMonth: {
              type: new GraphQLNonNull(GraphQLInt),
              description: 'Number of expenses included in this subscription tier per month',
            },
          },
        }),
      ),
    },
    features: {
      type: new GraphQLNonNull(GraphQLPlatformSubscriptionFeatures),
      resolve: tier => {
        return tier.features || PlatformSubscriptionTiers.find(t => t.id === tier.basePlanId)?.features || {};
      },
    },
  }),
});

const GraphQLPlatformSubscriptionFeatures = new GraphQLObjectType({
  name: 'PlatformSubscriptionFeatures',
  fields: () => ({
    ...CommercialFeatures.reduce(
      (acc, feature) => ({
        ...acc,
        [feature]: {
          type: new GraphQLNonNull(GraphQLBoolean),
          resolve(features: Partial<Record<CommercialFeaturesType, boolean>>) {
            return features?.[feature] ?? false;
          },
        },
      }),
      {},
    ),
  }),
});
