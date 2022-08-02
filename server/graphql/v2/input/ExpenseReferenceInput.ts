import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { uniq } from 'lodash';
import { Includeable } from 'sequelize';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

const ExpenseReferenceInput = new GraphQLInputObjectType({
  name: 'ExpenseReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the expense (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the expense (ie: 580)',
    },
  }),
});

const getDatabaseIdFromExpenseReference = (input: Record<string, unknown>): number => {
  if (input['id']) {
    return idDecode(input['id'], IDENTIFIER_TYPES.EXPENSE);
  } else if (input['legacyId']) {
    return <number>input['legacyId'];
  } else {
    return null;
  }
};

/**
 * Retrieve an expense from an `ExpenseReferenceInput`
 */
const fetchExpenseWithReference = async (
  input: Record<string, unknown>,
  { loaders = null, throwIfMissing = false } = {},
): Promise<typeof models.Expense> => {
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

/**
 * Retrieve expenses from a list of expense reference inputs.
 *
 * This does not use a graphql loader, careful to use for a list
 * @param inputs
 * @returns
 */
const fetchExpensesWithReferences = async (
  inputs: Record<string, unknown>[],
  opts: { throwIfMissing?: boolean; include?: Includeable } = {},
): Promise<typeof models.Expense[]> => {
  if (inputs.length === 0) {
    return [];
  }

  const ids = uniq(inputs.map(getDatabaseIdFromExpenseReference));
  const expenses = await models.Expense.findAll({ where: { id: ids }, include: opts.include });

  // Check if all expenses were found
  if (opts.throwIfMissing && ids.length !== expenses.length) {
    const missingExpenseIds = ids.filter(id => !expenses.find(expense => expense.id === id));
    throw new NotFound(`Could not find expenses with ids: ${missingExpenseIds.join(', ')}`);
  }

  return expenses;
};

export {
  ExpenseReferenceInput,
  fetchExpenseWithReference,
  fetchExpensesWithReferences,
  getDatabaseIdFromExpenseReference,
};
