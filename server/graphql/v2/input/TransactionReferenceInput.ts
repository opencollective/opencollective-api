import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

const TransactionReferenceInput = new GraphQLInputObjectType({
  name: 'TransactionReferenceInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'The public id identifying the transaction (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the transaction (ie: 580)',
    },
  },
});

const getDatabaseIdFromTransactionReference = (input: object): number => {
  if (input['id']) {
    return idDecode(input['id'], IDENTIFIER_TYPES.TRANSACTION);
  } else if (input['legacyId']) {
    return input['legacyId'];
  } else {
    return null;
  }
};

/**
 * Retrieve an expense from an `ExpenseReferenceInput`
 */
const fetchTransactionWithReference = async (
  input: object,
  { loaders = null, throwIfMissing = false } = {},
): Promise<any> => {
  const dbId = getDatabaseIdFromTransactionReference(input);
  let transaction = null;
  if (dbId) {
    transaction = await (loaders ? loaders.Transaction.byId.load(dbId) : models.Transaction.findByPk(dbId));
  }

  if (!transaction && throwIfMissing) {
    throw new NotFound();
  }

  return transaction;
};

export { TransactionReferenceInput, fetchTransactionWithReference, getDatabaseIdFromTransactionReference };
