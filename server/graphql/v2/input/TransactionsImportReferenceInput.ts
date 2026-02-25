import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { TransactionsImport } from '../../../models';
import { idDecode } from '../identifiers';

export type GraphQLTransactionsImportReferenceInputFields = {
  publicId?: string;
  id?: string;
};

export const GraphQLTransactionsImportReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionsImportReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${TransactionsImport.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The id of the row',
      deprecationReason: '2026-02-25: use publicId',
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
  if (input.publicId) {
    const expectedPrefix = TransactionsImport.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for TransactionsImport, expected prefix ${expectedPrefix}_`);
    }

    row = await TransactionsImport.findOne({ where: { publicId: input.publicId }, ...sequelizeOpts });
  } else if (input.id) {
    const decodedId = idDecode(input.id, 'transactions-import-row');
    row = await TransactionsImport.findByPk(decodedId, sequelizeOpts);
  }

  if (!row && throwIfMissing) {
    throw new Error(`TransactionsImport not found`);
  }

  return row;
};
