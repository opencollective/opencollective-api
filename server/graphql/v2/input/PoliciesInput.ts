import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt } from 'graphql';

import POLICIES from '../../../constants/policies';
import { GraphQLPolicyApplication } from '../enum/PolicyApplication';

export const GraphQLPoliciesInput = new GraphQLInputObjectType({
  name: 'PoliciesInput',
  fields: () => ({
    [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
      type: new GraphQLInputObjectType({
        name: 'PoliciesCollectiveExpenseAuthorCannotApprove',
        fields: () => ({
          amountInCents: { type: GraphQLInt },
          enabled: { type: GraphQLBoolean },
          appliesToHostedCollectives: { type: GraphQLBoolean },
          appliesToSingleAdminCollectives: { type: GraphQLBoolean },
        }),
      }),
    },
    [POLICIES.REQUIRE_2FA_FOR_ADMINS]: {
      type: GraphQLBoolean,
    },
    [POLICIES.COLLECTIVE_ADMINS_CAN_REFUND]: {
      type: GraphQLBoolean,
    },
    [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: {
      type: new GraphQLInputObjectType({
        name: 'PoliciesCollectiveMinimumAdminsInput',
        fields: () => ({
          numberOfAdmins: { type: GraphQLInt },
          applies: { type: GraphQLPolicyApplication },
          freeze: { type: GraphQLBoolean },
        }),
      }),
    },
    [POLICIES.EXPENSE_CATEGORIZATION]: {
      type: new GraphQLInputObjectType({
        name: 'PoliciesExpenseCategorizationInput',
        fields: () => ({
          requiredForExpenseSubmitters: { type: GraphQLBoolean },
          requiredForCollectiveAdmins: { type: GraphQLBoolean },
        }),
      }),
    },
  }),
});
