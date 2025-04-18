import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import POLICIES from '../../../constants/policies';
import { GraphQLPolicyApplication } from '../enum/PolicyApplication';

export const GraphQLPoliciesInput = new GraphQLInputObjectType({
  name: 'PoliciesInput',
  fields: () => ({
    [POLICIES.EXPENSE_POLICIES]: {
      type: new GraphQLInputObjectType({
        name: 'PoliciesExpensePolicies',
        fields: () => ({
          invoicePolicy: { type: GraphQLString },
          receiptPolicy: { type: GraphQLString },
          titlePolicy: { type: GraphQLString },
          grantPolicy: { type: GraphQLString },
        }),
      }),
    },
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
    [POLICIES.EXPENSE_PUBLIC_VENDORS]: {
      type: GraphQLBoolean,
    },
    [POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS]: {
      type: GraphQLBoolean,
    },
    [POLICIES.CONTRIBUTOR_INFO_THRESHOLDS]: {
      type: new GraphQLInputObjectType({
        name: 'PoliciesContributorInfoThresholdsInput',
        fields: () => ({
          legalName: { type: GraphQLInt },
          address: { type: GraphQLInt },
        }),
      }),
    },
  }),
});
