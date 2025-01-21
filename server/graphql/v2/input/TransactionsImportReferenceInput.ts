import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { TransactionsImport } from '../../../models';
import { idDecode } from '../identifiers';

export type GraphQLTransactionsImportReferenceInputFields = {
  id: string;
};

export const GraphQLTransactionsImportReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionsImportReferenceInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The id of the row',
    },
  }),
});

export const fetchTransactionsImportWithReference = async (
  input: GraphQLTransactionsImportReferenceInputFields,
  { throwIfMissing = false, ...sequelizeOpts } = {},
): Promise<TransactionsImport> => {
  let row;
  if (input.id) {
    const decodedId = idDecode(input.id, 'transactions-import-row');
    row = await TransactionsImport.findByPk(decodedId, sequelizeOpts);
  }

  if (!row && throwIfMissing) {
    throw new Error(`TransactionsImport not found`);
  }

  return row;
};
