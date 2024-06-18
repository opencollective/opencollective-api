import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { TransactionsImportRow } from '../../../models';
import { idDecode } from '../identifiers';

export type GraphQLTransactionsImportRowReferenceInputFields = {
  id: string;
};

export const GraphQLTransactionsImportRowReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionsImportRowReferenceInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The id of the row',
    },
  }),
});

export const fetchTransactionsImportRowWithReference = async (
  input: { id: string },
  { throwIfMissing = false, ...sequelizeOpts } = {},
): Promise<TransactionsImportRow> => {
  let row;
  if (input.id) {
    const decodedId = idDecode(input.id, 'transactions-import-row');
    row = await TransactionsImportRow.findByPk(decodedId, sequelizeOpts);
  }

  if (!row && throwIfMissing) {
    throw new Error(`TransactionsImportRow not found`);
  }

  return row;
};
