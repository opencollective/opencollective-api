import { GraphQLEnumType } from 'graphql';

import { PayoutMethodTypes } from '../../../models/PayoutMethod.js';

export const GraphQLPayoutMethodType = new GraphQLEnumType({
  name: 'PayoutMethodType',
  values: Object.keys(PayoutMethodTypes).reduce((values, key) => {
    return { ...values, [key]: { value: PayoutMethodTypes[key] } };
  }, {}),
});

export default GraphQLPayoutMethodType;
