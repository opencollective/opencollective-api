import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt } from 'graphql';

import POLICIES from '../../../constants/policies';
import { PolicyApplication } from '../enum/PolicyApplication';

export const PoliciesInput = new GraphQLInputObjectType({
  name: 'PoliciesInput',
  fields: () => ({
    [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
      type: GraphQLBoolean,
    },
    [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: {
      type: new GraphQLInputObjectType({
        name: 'PoliciesCollectiveMinimumAdminsInput',
        fields: () => ({
          numberOfAdmins: { type: GraphQLInt },
          applies: { type: PolicyApplication },
          freeze: { type: GraphQLBoolean },
        }),
      }),
    },
  }),
});
