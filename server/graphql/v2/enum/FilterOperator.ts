import { GraphQLEnumType } from 'graphql';

export const GraphQLFilterOperator = new GraphQLEnumType({
  name: 'FilterOperator',
  description: 'The operator to use with an argument of type array.',
  values: {
    IN: {},
    NOT_IN: {},
  },
});
