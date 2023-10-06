import { GraphQLEnumType } from 'graphql';

export const GraphQLTagSearchOperator = new GraphQLEnumType({
  name: 'TagSearchOperator',
  description: 'The operator to use when searching with tags',
  values: {
    AND: {},
    OR: {},
  },
});
