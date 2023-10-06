import { GraphQLEnumType } from 'graphql';

export const GraphQLPolicyApplication = new GraphQLEnumType({
  name: `PolicyApplication`,
  description: 'Defines how the policy is applied',
  values: { ALL_COLLECTIVES: { value: 'ALL_COLLECTIVES' }, NEW_COLLECTIVES: { value: 'NEW_COLLECTIVES' } },
});
