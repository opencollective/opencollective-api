import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';
import { FindOptions, InferAttributes } from 'sequelize';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import { TransactionsImportRow } from '../../../models';
import { Loaders } from '../../loaders';
import { idDecode } from '../identifiers';

export type GraphQLTransactionsImportRowReferenceInputFields = {
  id: string;
};

export const GraphQLTransactionsImportRowReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionsImportRowReferenceInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: `The id of the row (ie: ${TransactionsImportRow.nanoIdPrefix}_xxxxxxxx)`,
    },
  }),
});

export const fetchTransactionsImportRowWithReference = async (
  input: { id?: string },
  {
    loaders = null,
    throwIfMissing = false,
    ...sequelizeOpts
  }: { loaders?: Loaders; throwIfMissing?: boolean } & FindOptions<InferAttributes<TransactionsImportRow>> = {},
): Promise<TransactionsImportRow> => {
  let row: TransactionsImportRow | null = null;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.TransactionsImportRow)) {
    row = await (loaders
      ? loaders.TransactionsImportRow.byPublicId.load(input.id)
      : TransactionsImportRow.findOne({ where: { publicId: input.id }, ...sequelizeOpts }));
  } else if (input.id) {
    const decodedId = idDecode(input.id, 'transactions-import-row');
    row = await TransactionsImportRow.findByPk(decodedId, sequelizeOpts);
  }

  if (!row && throwIfMissing) {
    throw new Error(`TransactionsImportRow not found`);
  }

  return row;
};
