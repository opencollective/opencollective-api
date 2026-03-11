import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models from '../../../models';
import Transaction from '../../../models/Transaction';
import { NotFound } from '../../errors';
import { Loaders } from '../../loaders';

const GraphQLTransactionReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the transaction (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${EntityShortIdPrefix.Transaction}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the transaction (ie: 580)',
      deprecationReason: '2026-02-25: use id',
    },
  }),
});

/**
 * Retrieve an expense from an `ExpenseReferenceInput`
 */
const fetchTransactionWithReference = async (
  input: { id?: string; legacyId?: number },
  { loaders = null, throwIfMissing = false }: { loaders?: Loaders; throwIfMissing?: boolean } = {},
): Promise<Transaction> => {
  let transaction: Transaction | null = null;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.Transaction)) {
    transaction = await (loaders
      ? loaders.Transaction.byPublicId.load(input.id)
      : models.Transaction.findOne({ where: { publicId: input.id } }));
  } else if (input.id) {
    transaction = await models.Transaction.findOne({ where: { uuid: input.id } });
  } else if (input.legacyId) {
    transaction = await (loaders
      ? loaders.Transaction.byId.load(input.legacyId)
      : models.Transaction.findByPk(input.legacyId));
  }

  if (!transaction && throwIfMissing) {
    throw new NotFound(`Transaction not found`);
  }

  return transaction;
};

export { GraphQLTransactionReferenceInput, fetchTransactionWithReference };
