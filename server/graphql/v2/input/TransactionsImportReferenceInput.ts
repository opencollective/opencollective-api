import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import { TransactionsImport } from '../../../models';
import { idDecode } from '../identifiers';

export type GraphQLTransactionsImportReferenceInputFields = {
  id?: string;
};

export const GraphQLTransactionsImportReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionsImportReferenceInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: `The id of the row (ie: ${EntityShortIdPrefix.TransactionsImport}_xxxxxxxx)`,
    },
  }),
});

export const fetchTransactionsImportWithReference = async (
  input: GraphQLTransactionsImportReferenceInputFields,
  {
    throwIfMissing = false,
    ...sequelizeOpts
  }: { throwIfMissing?: boolean } & Parameters<typeof TransactionsImport.findByPk>[1] = {},
): Promise<TransactionsImport> => {
  let row;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.TransactionsImport)) {
    row = await TransactionsImport.findOne({ where: { publicId: input.id }, ...sequelizeOpts });
  } else if (input.id) {
    const decodedId = idDecode(input.id, 'transactions-import-row');
    row = await TransactionsImport.findByPk(decodedId, sequelizeOpts);
  }

  if (!row && throwIfMissing) {
    throw new Error(`TransactionsImport not found`);
  }

  return row;
};
