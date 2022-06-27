import { GraphQLEnumType } from 'graphql';

import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';

export const HostFeeStructure = new GraphQLEnumType({
  name: 'HostFeeStructure',
  description: 'All supported expense types',
  values: {
    [HOST_FEE_STRUCTURE.DEFAULT]: {
      description: 'Use global host fees',
    },
    [HOST_FEE_STRUCTURE.CUSTOM_FEE]: {
      description: 'Custom fee for this Collective only',
    },
    [HOST_FEE_STRUCTURE.MONTHLY_RETAINER]: {
      description: 'Set a monthly retainer for this Collective',
    },
  },
});
