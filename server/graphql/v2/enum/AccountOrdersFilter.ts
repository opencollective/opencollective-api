import { GraphQLEnumType } from 'graphql';

export enum GraphQLAccountOrdersFilterValues {
  INCOMING = 'INCOMING',
  OUTGOING = 'OUTGOING',
}

export const GraphQLAccountOrdersFilter = new GraphQLEnumType({
  name: 'AccountOrdersFilter',
  description: 'Account orders filter (INCOMING or OUTGOING)',
  values: {
    INCOMING: {},
    OUTGOING: {},
  } satisfies Record<keyof typeof GraphQLAccountOrdersFilterValues, object>,
});
