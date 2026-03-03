import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { partition, uniq } from 'lodash';
import { Includeable, Op } from 'sequelize';

import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import models from '../../../models';
import Expense from '../../../models/Expense';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

export interface ExpenseReferenceInputFields {
  id?: string;
  legacyId?: number;
}

const GraphQLExpenseReferenceInput = new GraphQLInputObjectType({
  name: 'ExpenseReferenceInput',
  fields: (): Record<keyof ExpenseReferenceInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: GraphQLString,
      description: `The public id identifying the expense (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re, ${EntityShortIdPrefix.Expense}_xxxxxxxx)`,
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the expense (ie: 580)',
      deprecationReason: '2026-02-25: use id',
    },
  }),
});

const getDatabaseIdFromExpenseReference = (input: ExpenseReferenceInputFields): number => {
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
  input: ExpenseReferenceInputFields,
  { loaders = null, throwIfMissing = false } = {},
): Promise<Expense> => {
  let expense = null;
  if (isEntityPublicId(input.id, EntityShortIdPrefix.Expense)) {
    expense = await Expense.findOne({ where: { publicId: input.id } });
  } else {
    const dbId = getDatabaseIdFromExpenseReference(input);
    if (dbId) {
      expense = await (loaders ? loaders.Expense.byId.load(dbId) : models.Expense.findByPk(dbId));
    }
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
  inputs: ExpenseReferenceInputFields[],
  opts: { throwIfMissing?: boolean; include?: Includeable } = {},
): Promise<Expense[]> => {
  if (inputs.length === 0) {
    return [];
  }

  const [inputsWithPublicId, inputsWithoutPublicId] = partition(
    inputs,
    input => input.id && isEntityPublicId(input.id, EntityShortIdPrefix.Expense),
  );

  const ids = uniq(inputsWithoutPublicId.map(getDatabaseIdFromExpenseReference));
  const publicIds = uniq(inputsWithPublicId.map(input => input.id));

  const where: { [key: string]: unknown } & { [Op.or]?: unknown } = {};
  if (ids.length && publicIds.length) {
    where[Op.or] = [{ id: ids }, { publicId: publicIds }];
  } else if (ids.length) {
    where.id = ids;
  } else if (publicIds.length) {
    where.publicId = publicIds;
  }

  const expenses = await models.Expense.findAll({ where, include: opts.include });

  // Check if all expenses were found
  if (opts.throwIfMissing && ids.length !== expenses.length) {
    const missingExpenseIds = [...ids, ...publicIds].filter(
      id => !expenses.find(expense => expense.id === id || expense.publicId === id),
    );
    throw new NotFound(`Could not find expenses with ids: ${missingExpenseIds.join(', ')}`);
  }

  return expenses;
};

export {
  GraphQLExpenseReferenceInput,
  fetchExpenseWithReference,
  fetchExpensesWithReferences,
  getDatabaseIdFromExpenseReference,
};
