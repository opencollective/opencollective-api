import { GraphQLEnumType } from 'graphql';

export const GraphQLDateTimeField = new GraphQLEnumType({
  name: 'DateTimeField',
  description: 'All possible DateTime fields for a resource',
  values: {
    CREATED_AT: {
      value: 'createdAt',
      description: 'The creation time of a resource',
    },
  },
});
