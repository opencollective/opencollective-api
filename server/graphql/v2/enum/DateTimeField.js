import { GraphQLEnumType } from 'graphql';

export const DateTimeField = new GraphQLEnumType({
  name: 'DateTimeField',
  description: 'All possible DateTime fields for a resource',
  values: {
    CREATED_AT: {
      value: 'createdAt',
      description: 'The creation time of a resource',
    },
    UPDATED_AT: {
      value: 'updatedAt',
      description: 'The update time of a resource',
    },
    PUBLISHED_AT: {
      value: 'publishedAt',
      description: 'The publication time of a resource (if available)',
    },
  },
});
