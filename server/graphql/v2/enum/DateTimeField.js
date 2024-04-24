import { GraphQLEnumType } from 'graphql';

export const GraphQLDateTimeField = new GraphQLEnumType({
  name: 'DateTimeField',
  description: 'All possible DateTime fields for a resource',
  values: {
    CREATED_AT: {
      value: 'createdAt',
      description: 'The creation time of a resource',
    },
    EFFECTIVE_DATE: {
      value: 'clearedAt',
      description: 'Transactions only: The date when a transaction was cleared by the payment processor',
    },
  },
});
