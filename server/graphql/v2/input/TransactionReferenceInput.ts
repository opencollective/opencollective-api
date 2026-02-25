import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import Transaction from '../../../models/Transaction';
import { NotFound } from '../../errors';

const GraphQLTransactionReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${Transaction.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the transaction (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the transaction (ie: 580)',
    },
  }),
});

/**
 * Retrieve an expense from an `ExpenseReferenceInput`
 */
const fetchTransactionWithReference = async (
  input: { publicId?: string; id?: string; legacyId?: number },
  { loaders = null, throwIfMissing = false } = {},
): Promise<Transaction> => {
  let transaction = null;
  if (input.publicId) {
    const expectedPrefix = Transaction.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for Transaction, expected prefix ${expectedPrefix}_`);
    }

    transaction = await models.Transaction.findOne({ where: { publicId: input.publicId } });
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
