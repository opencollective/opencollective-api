import { GraphQLEnumType } from 'graphql';

import { HostApplicationStatus as HostApplicationStatusEnum } from '../../../models/HostApplication.js';

export const GraphQLHostApplicationStatus = new GraphQLEnumType({
  name: 'HostApplicationStatus',
  values: Object.values(HostApplicationStatusEnum).reduce((values, key) => {
    return { ...values, [key]: { value: key } };
  }, {}),
});
