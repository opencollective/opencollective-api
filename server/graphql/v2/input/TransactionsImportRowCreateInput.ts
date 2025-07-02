import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSONObject, GraphQLNonEmptyString } from 'graphql-scalars';

import { GraphQLAmountInput } from './AmountInput';

export const GraphQLTransactionsImportRowCreateInput = new GraphQLInputObjectType({
  name: 'TransactionsImportRowCreateInput',
  fields: () => ({
    sourceId: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The source id of the row',
    },
    description: {
      type: GraphQLString,
      description: 'The description of the row',
    },
    date: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date of the row',
    },
    amount: {
      type: new GraphQLNonNull(GraphQLAmountInput),
      description: 'The amount of the row',
    },
    accountId: {
      type: GraphQLString,
      description: 'The account ID associated with the row',
    },
    rawValue: {
      type: GraphQLJSONObject,
      description: 'The raw value of the row',
    },
  }),
});
