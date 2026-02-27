import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';

import { TransactionsImportRow } from '../../../models';
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
  note?: string | null;
  accountId?: string | null;
};

export const GraphQLTransactionsImportRowUpdateInput = new GraphQLInputObjectType({
  name: 'TransactionsImportRowUpdateInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The id of the row',
      deprecationReason: '2026-02-25: use publicId',
    },
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${TransactionsImportRow.nanoIdPrefix}_xxxxxxxx)`,
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
    note: {
      type: GraphQLString,
      description: 'Optional note for the row',
    },
    accountId: {
      type: GraphQLString,
      description: 'The account ID associated with the row',
    },
  }),
});
