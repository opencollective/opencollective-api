import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';

import { GraphQLTransactionsImportRowStatus, TransactionsImportRowStatus } from '../enum/TransactionsImportRowStatus';

import { AmountInputType, GraphQLAmountInput } from './AmountInput';
import { ExpenseReferenceInputFields, GraphQLExpenseReferenceInput } from './ExpenseReferenceInput';
import { GraphQLOrderReferenceInput, OrderReferenceInputGraphQLType } from './OrderReferenceInput';

export type TransactionImportRowGraphQLType = {
  id: string;
  sourceId?: string | null;
  description?: string | null;
  date?: string | null;
  amount?: AmountInputType | null;
  status?: TransactionsImportRowStatus | null;
  order?: OrderReferenceInputGraphQLType | null;
  expense: ExpenseReferenceInputFields | null;
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
    status: {
      type: GraphQLTransactionsImportRowStatus,
      description:
        'To update the status of the row. Will be ignored if the status is not applicable (e.g. trying to ignore a row that is already linked)',
    },
    order: {
      type: GraphQLOrderReferenceInput,
      description: 'The order associated with the row',
    },
    expense: {
      type: GraphQLExpenseReferenceInput,
      description: 'The expense associated with the row',
    },
  }),
});
