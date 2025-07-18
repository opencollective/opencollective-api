import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLCollectiveFeatureStatus } from '../../common/CollectiveFeatures';
import GraphQLFeature from '../enum/Feature';

export const GraphQLFeatureToggleInput = new GraphQLInputObjectType({
  name: 'FeatureToggleInput',
  description: 'Input type for toggling features on or off for an acccount',
  fields: () => ({
    key: {
      type: new GraphQLNonNull(GraphQLFeature),
      description: 'Feature to toggle.',
    },
    status: {
      type: new GraphQLNonNull(GraphQLCollectiveFeatureStatus),
      description: 'Status to set the feature to.',
    },
  }),
});
