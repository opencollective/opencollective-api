import { GraphQLEnumType } from 'graphql';

import channels from '../../../constants/channels';

export const NotificationChannel = new GraphQLEnumType({
  name: 'NotificationChannel',
  description: 'All supported notification channels we can broadcast activity',
  values: Object.values(channels).reduce(
    (values, key) => ({
      ...values,
      [key]: { value: key },
    }),
    {},
  ),
});
