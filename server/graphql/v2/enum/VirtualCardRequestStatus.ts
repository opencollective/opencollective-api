import { GraphQLEnumType } from 'graphql';

import { VirtualCardRequestStatus } from '../../../models/VirtualCardRequest';

export const GraphQLVirtualCardRequestStatus = new GraphQLEnumType({
  name: 'VirtualCardRequestStatus',
  description: 'The status of a virtual card request',
  values: Object.keys(VirtualCardRequestStatus).reduce((acc, key) => {
    return {
      ...acc,
      [key]: {
        value: VirtualCardRequestStatus[key],
      },
    };
  }, {}),
});
