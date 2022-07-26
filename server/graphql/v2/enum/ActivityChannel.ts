import { GraphQLEnumType } from 'graphql';

import channels from '../../../constants/channels';

export const ActivityChannel = new GraphQLEnumType({
  name: 'ActivityChannel',
  description: 'All supported Activity channels we can broadcast to',
  values: Object.values(channels).reduce(
    (values, key) => ({
      ...values,
      [key]: { value: key },
    }),
    {},
  ),
});
