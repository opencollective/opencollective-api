import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { FeaturesList } from '../../constants/feature';
import FEATURE_STATUS from '../../constants/feature-status';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../v2/identifiers';

import { getFeatureStatusResolver } from './features';

const GraphQLCollectiveFeatureStatus = new GraphQLEnumType({
  name: 'CollectiveFeatureStatus',
  values: {
    [FEATURE_STATUS.ACTIVE]: {
      description: 'The feature is enabled and is actively used',
    },
    [FEATURE_STATUS.AVAILABLE]: {
      description: 'The feature is enabled, but there is no data for it',
    },
    [FEATURE_STATUS.DISABLED]: {
      description: 'The feature is disabled, but can be enabled by an admin',
    },
    [FEATURE_STATUS.UNSUPPORTED]: {
      description: 'The feature is disabled and cannot be activated for this account',
    },
  },
});

const FeaturesFields = () => {
  return FeaturesList.reduce(
    (obj, feature) =>
      Object.assign(obj, {
        [feature]: {
          type: GraphQLCollectiveFeatureStatus,
          resolve: getFeatureStatusResolver(feature),
        },
      }),
    {},
  );
};

/**
 * A special type shared between GraphQL V1 and V2 to facilitate the migration
 */
export const GraphQLCollectiveFeatures = new GraphQLObjectType({
  name: 'CollectiveFeatures',
  description: 'Describes the features enabled and available for this account',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The id of the account',
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACCOUNT),
      },
      ...FeaturesFields(),
    };
  },
});
