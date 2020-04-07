import { GraphQLEnumType } from 'graphql';
import ACTIVITY from '../../../constants/activities';

export const ActivityType = new GraphQLEnumType({
  name: 'ActivityType',
  values: Object.keys(ACTIVITY).reduce((values, key) => {
    return {
      ...values,
      [key]: { value: ACTIVITY[key] },
    };
  }, {}),
});
