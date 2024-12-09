import { GraphQLEnumType } from 'graphql';

import goalType from '../../../constants/goal-types';

export const GraphQLGoalType = new GraphQLEnumType({
  name: 'GoalType',
  description: 'All supported goal types',
  values: {
    [goalType.ALL_TIME]: {
      description: 'Total contributions',
    },
    [goalType.MONTHLY_BUDGET]: {
      description:
        'Active yearly contributions (divided by 12), active monthly contributions and one-time contributions in the past 30 days',
    },
    [goalType.YEARLY_BUDGET]: {
      description:
        'Active yearly contributions , active monthly contributions (times 12) and one-time contributions in the past 365 days',
    },
    [goalType.CALENDAR_MONTH]: {
      description: 'Contributions in the current calendar month',
    },
    [goalType.CALENDAR_YEAR]: {
      description: 'Contributions in the current calendar year',
    },
  },
});
