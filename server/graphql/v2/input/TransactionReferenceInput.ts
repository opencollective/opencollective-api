import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { TransactionModelInterface } from '../../../models/Transaction';
import { NotFound } from '../../errors';

const TransactionReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionReferenceInput',
  fields: () => ({
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
  input: Record<string, unknown>,
  { loaders = null, throwIfMissing = false } = {},
): Promise<TransactionModelInterface> => {
  let transaction = null;
  if (input.id) {
    transaction = await models.Transaction.findOne({ where: { uuid: input.id } });
  } else if (input.legacyId) {
    transaction = await (loaders
      ? loaders.Transaction.byId.load(input.legacyId)
      : models.Transaction.findByPk(input.legacyId as any));
  }

  if (!transaction && throwIfMissing) {
    throw new NotFound(`Transaction not found`);
  }

  return transaction;
};

export { TransactionReferenceInput, fetchTransactionWithReference };
