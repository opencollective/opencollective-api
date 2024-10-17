import { GraphQLEnumType } from 'graphql';

import goalType from '../../../constants/goal-types';

export const GraphQLGoalType = new GraphQLEnumType({
  name: 'GoalType',
  description: 'All supported goal types',
  values: {
    [goalType.ALL_TIME]: {
      description: 'Total contributions',
    },
    [goalType.MONTHLY]: {
      description: 'Contributions per month',
    },
    [goalType.YEARLY]: {
      description: 'Contributions per year',
    },
  },
});
