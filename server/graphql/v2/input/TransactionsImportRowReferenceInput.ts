import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { TransactionsImportRow } from '../../../models';
import { idDecode } from '../identifiers';

export type GraphQLTransactionsImportRowReferenceInputFields = {
  id: string;
};

export const GraphQLTransactionsImportRowReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionsImportRowReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${TransactionsImportRow.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLNonEmptyString,
      description: 'The id of the row',
      deprecationReason: '2026-02-25: use publicId',
    },
  }),
});

export const fetchTransactionsImportRowWithReference = async (
  input: { publicId?: string; id?: string },
  { throwIfMissing = false, ...sequelizeOpts } = {},
): Promise<TransactionsImportRow> => {
  let row;
  if (input.publicId) {
    const expectedPrefix = TransactionsImportRow.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for TransactionsImportRow, expected prefix ${expectedPrefix}_`);
    }

    row = await TransactionsImportRow.findOne({ where: { publicId: input.publicId }, ...sequelizeOpts });
  } else if (input.id) {
    const decodedId = idDecode(input.id, 'transactions-import-row');
    row = await TransactionsImportRow.findByPk(decodedId, sequelizeOpts);
  }

  if (!row && throwIfMissing) {
    throw new Error(`TransactionsImportRow not found`);
  }

  return row;
};
