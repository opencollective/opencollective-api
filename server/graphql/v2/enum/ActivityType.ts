import { GraphQLEnumType } from 'graphql';

import ACTIVITY, { ActivityClasses } from '../../../constants/activities';

const Activities = Object.keys(ACTIVITY).reduce((values, key) => {
  return {
    ...values,
    [key]: { value: ACTIVITY[key] },
  };
}, {});

const Classes = Object.keys(ActivityClasses).reduce((values, key) => {
  return {
    ...values,
    [key]: { value: ActivityClasses[key] },
  };
}, {});

export const ActivityType = new GraphQLEnumType({
  name: 'ActivityType',
  values: Activities,
});

export const ActivityAndClassesType = new GraphQLEnumType({
  name: 'ActivityAndClassesType',
  values: { ...Activities, ...Classes },
});
