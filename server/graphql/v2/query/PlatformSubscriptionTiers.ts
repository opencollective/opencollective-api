import { GraphQLList } from 'graphql';

import { PlatformSubscriptionTiers } from '../../../constants/plans';
import { GraphQLPlatformSubscriptionTier } from '../object/PlatformSubscriptionTier';

const platformSubscriptionTiers = {
  type: new GraphQLList(GraphQLPlatformSubscriptionTier),
  extensions: { cost: { listSize: 20 } },
  resolve() {
    return PlatformSubscriptionTiers;
  },
};

export default platformSubscriptionTiers;
