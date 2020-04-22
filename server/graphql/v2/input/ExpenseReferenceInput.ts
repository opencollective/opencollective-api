import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

const ExpenseReferenceInput = new GraphQLInputObjectType({
  name: 'ExpenseReferenceInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'The public id identifying the expense (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the expense (ie: 580)',
    },
  },
});

const getDatabaseIdFromExpenseReference = (input: object): number => {
  if (input['id']) {
    return idDecode(input['id'], IDENTIFIER_TYPES.EXPENSE);
  } else if (input['legacyId']) {
    return input['legacyId'];
  } else {
    return null;
  }
};

/**
 * Retrieve an expense from an `ExpenseReferenceInput`
 */
const fetchExpenseWithReference = async (
  input: object,
  { loaders = null, throwIfMissing = false } = {},
): Promise<any> => {
  const dbId = getDatabaseIdFromExpenseReference(input);
  let expense = null;
  if (dbId) {
    expense = await (loaders ? loaders.Expense.byId.load(dbId) : models.Expense.findByPk(dbId));
  }

  if (!expense && throwIfMissing) {
    throw new NotFound();
  }

  return expense;
};

export { ExpenseReferenceInput, fetchExpenseWithReference, getDatabaseIdFromExpenseReference };
