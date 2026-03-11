import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';
import { FindOptions, InferAttributes } from 'sequelize';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import { TransactionsImport } from '../../../models';
import { Loaders } from '../../loaders';
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
    loaders = null,
    throwIfMissing = false,
    ...sequelizeOpts
  }: { loaders?: Loaders; throwIfMissing?: boolean } & FindOptions<InferAttributes<TransactionsImport>> = {},
): Promise<TransactionsImport> => {
  let row;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.TransactionsImport)) {
    row = await (loaders
      ? loaders.TransactionsImport.byPublicId.load(input.id)
      : TransactionsImport.findOne({ where: { publicId: input.id }, ...sequelizeOpts }));
  } else if (input.id) {
    const decodedId = idDecode(input.id, 'transactions-import-row');
    row = await TransactionsImport.findByPk(decodedId, sequelizeOpts);
  }

  if (!row && throwIfMissing) {
    throw new Error(`TransactionsImport not found`);
  }

  return row;
};
