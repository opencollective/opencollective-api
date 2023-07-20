import { GraphQLEnumType } from 'graphql';

import { VirtualCardStatus } from '../../../models/VirtualCard.js';

export const GraphQLVirtualCardStatusEnum = new GraphQLEnumType({
  name: 'VirtualCardStatus',
  description: 'The status of a virtual card',
  values: Object.keys(VirtualCardStatus).reduce((acc, key) => {
    return {
      ...acc,
      [key]: {
        value: VirtualCardStatus[key],
      },
    };
  }, {}),
});
