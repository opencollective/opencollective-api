import { GraphQLEnumType } from 'graphql';

import { VirtualCardLimitIntervals } from '../../../constants/virtual-cards';

export const VirtualCardLimitInterval = new GraphQLEnumType({
  name: 'VirtualCardLimitInterval',
  values: Object.keys(VirtualCardLimitIntervals).reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});
