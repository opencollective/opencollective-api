import { GraphQLEnumType } from 'graphql';

export const GraphQLUpdateDateTimeField = new GraphQLEnumType({
  name: 'UpdateDateTimeField',
  description: 'All possible DateTime fields for an update',
  values: {
    CREATED_AT: {
      value: 'createdAt',
      description: 'The creation time',
    },
    PUBLISHED_AT: {
      value: 'publishedAt',
      description: 'The creation time',
    },
  },
});
