import { GraphQLEnumType } from 'graphql';

export const GraphQLAccountOrdersFilter = new GraphQLEnumType({
  name: 'AccountOrdersFilter',
  description: 'Account orders filter (INCOMING or OUTGOING)',
  values: {
    INCOMING: {},
    OUTGOING: {},
  },
});
