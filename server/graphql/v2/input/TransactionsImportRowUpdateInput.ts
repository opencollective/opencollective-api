import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';

import { GraphQLAmountInput } from './AmountInput';
import { GraphQLOrderReferenceInput } from './OrderReferenceInput';

export const GraphQLTransactionsImportRowUpdateInput = new GraphQLInputObjectType({
  name: 'TransactionsImportRowUpdateInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The id of the row',
    },
    sourceId: {
      type: GraphQLNonEmptyString,
      description: 'The source id of the row',
    },
    description: {
      type: GraphQLString,
      description: 'The description of the row',
    },
    date: {
      type: GraphQLDateTime,
      description: 'The date of the row',
    },
    amount: {
      type: GraphQLAmountInput,
      description: 'The amount of the row',
    },
    isDismissed: {
      type: GraphQLBoolean,
      description: 'Whether the row is dismissed',
      defaultValue: false,
    },
    order: {
      type: GraphQLOrderReferenceInput,
      description: 'The order associated with the row',
    },
  }),
});
