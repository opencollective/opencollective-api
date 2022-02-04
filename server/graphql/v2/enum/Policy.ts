import { GraphQLEnumType } from 'graphql';

import POLICIES from '../../../constants/policies';

export const Policy = new GraphQLEnumType({
  name: 'Policy',
  values: Object.keys(POLICIES).reduce((values, key) => ({ ...values, [key]: { value: POLICIES[key] } }), {}),
});

export { POLICIES };
