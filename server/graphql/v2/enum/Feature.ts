import { GraphQLEnumType } from 'graphql';

import { FeaturesList } from '../../../constants/feature';

const GraphQLFeature = new GraphQLEnumType({
  name: 'Feature',
  values: FeaturesList.reduce((values, key) => {
    return { ...values, [key]: { value: key } };
  }, {}),
});

export default GraphQLFeature;
