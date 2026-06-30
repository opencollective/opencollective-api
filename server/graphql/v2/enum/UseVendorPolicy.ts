import { GraphQLEnumType } from 'graphql';

import { UseVendorPolicyValue } from '../../../constants/policies';

export const GraphQLUseVendorPolicy = new GraphQLEnumType({
  name: 'UseVendorPolicy',
  description: 'Who can attribute financial activities to a vendor',
  values: {
    [UseVendorPolicyValue.HOST_ADMINS]: {
      value: UseVendorPolicyValue.HOST_ADMINS,
      description: 'Only host admins can use this vendor.',
    },
    [UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS]: {
      value: UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS,
      description: 'Host admins and admins of hosted collectives.',
    },
    [UseVendorPolicyValue.ALL_SUBMITTERS]: {
      value: UseVendorPolicyValue.ALL_SUBMITTERS,
      description: 'Anyone who can submit an expense.',
    },
  },
});
