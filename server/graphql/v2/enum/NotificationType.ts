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

export const NotificationType = new GraphQLEnumType({
  name: 'NotificationType',
  values: { ...Activities, ...Classes },
});
