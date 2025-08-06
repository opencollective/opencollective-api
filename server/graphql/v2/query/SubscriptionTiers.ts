import { GraphQLList } from 'graphql';

import { PlatformSubscriptionTiers } from '../../../constants/plans';
import { GraphQLPlatformSubscriptionTier } from '../object/PlatformSubscriptionTier';

const platformSubscriptionTiers = {
  type: new GraphQLList(GraphQLPlatformSubscriptionTier),
  resolve() {
    return PlatformSubscriptionTiers;
  },
};

export default platformSubscriptionTiers;
