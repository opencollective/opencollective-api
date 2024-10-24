import { GraphQLBoolean, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';

import { AmountInputType, GraphQLAmountInput } from './AmountInput';
import { GraphQLOrderReferenceInput, OrderReferenceInputGraphQLType } from './OrderReferenceInput';

export type TransactionImportRowGraphQLType = {
  id: string;
  sourceId?: string | null;
  description?: string | null;
  date?: string | null;
  amount?: AmountInputType | null;
  isDismissed?: boolean | null;
  order?: OrderReferenceInputGraphQLType | null;
};

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
