import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { CommercialFeatures, CommercialFeaturesType } from '../../../constants/feature';
import { PlatformSubscription } from '../../../models';

export const GraphQLPlatformSubscriptionTier = new GraphQLObjectType({
  name: 'PlatformSubscriptionTier',
  description: 'Type for Platform Subscription Tier',
  fields: () => ({
    title: {
      type: GraphQLString,
      description: 'The title of the subscription tier',
    },
    type: {
      type: GraphQLString,
      description: 'The type of the subscription tier (e.g., "basic", "premium")',
    },
    pricing: {
      type: new GraphQLObjectType({
        name: 'PlatformSubscriptionTierPricing',
        fields: {
          pricePerMonth: {
            type: GraphQLInt,
            description: 'The price of the subscription tier per month',
          },
          includedCollectives: {
            type: GraphQLInt,
            description: 'Number of collectives included in this subscription tier',
          },
          pricePerAdditionalCollective: {
            type: GraphQLInt,
            description: 'Price for each additional collective beyond the included limit',
          },
          includedExpensesPerMonth: {
            type: GraphQLInt,
            description: 'Number of expenses included in this subscription tier per month',
          },
          pricePerAdditionalExpense: {
            type: GraphQLInt,
            description: 'Price for each additional expense beyond the included limit',
          },
        },
      }),
    },
    features: {
      type: new GraphQLNonNull(GraphQLPlatformSubscriptionFeatures),
      resolve(platformSubscription: PlatformSubscription) {
        return platformSubscription.plan?.features ?? {};
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
