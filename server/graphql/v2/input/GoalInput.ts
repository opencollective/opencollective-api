import { GraphQLInputObjectType, GraphQLInt, GraphQLNonNull } from 'graphql';

import { GraphQLGoalType } from '../enum/GoalType';

export const GraphQLGoalInput = new GraphQLInputObjectType({
  name: 'GoalInput',
  description: 'Input type for Goals',
  fields: () => ({
    type: { type: new GraphQLNonNull(GraphQLGoalType) },
    amount: { type: new GraphQLNonNull(GraphQLInt) },
  }),
});
