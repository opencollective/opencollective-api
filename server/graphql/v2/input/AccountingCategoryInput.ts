import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import ExpenseTypes from '../../../constants/expense_type';
import models from '../../../models';
import { GraphQLExpenseType } from '../enum/ExpenseType';
import { idDecode } from '../identifiers';

export type AccountingCategoryInputFields = {
  id?: string;
  code?: string;
  name?: string;
  friendlyName?: string;
  expensesTypes?: ExpenseTypes[];
};

export const AccountingCategoryInput = new GraphQLInputObjectType({
  name: 'AccountingCategoryInput',
  description: 'Input for creating or updating an account category',
  fields: (): Record<keyof AccountingCategoryInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: GraphQLNonEmptyString,
      description: 'The ID of the accounting category to edit',
    },
    code: {
      type: GraphQLNonEmptyString,
      description: 'The code of the accounting category',
    },
    name: {
      type: GraphQLNonEmptyString,
      description: 'The technical name of the accounting category',
    },
    friendlyName: {
      type: GraphQLString,
      description: 'A friendly name for non-accountants (i.e. expense submitters and collective admins)',
    },
    expensesTypes: {
      type: new GraphQLList(GraphQLExpenseType),
      description: 'If meant for expenses, the types of expenses this category applies to',
    },
  }),
});

// Reference

export type AccountCategoryReferenceInputFields = {
  id: string;
};

/**
 * Only `id` is used at the moment, but we're implementing this as a reference type as we may want
 * to support fetching with a combination of `account` + `code` in the future.
 */
export const AccountingCategoryReferenceInput = new GraphQLInputObjectType({
  name: 'AccountingCategoryReferenceInput',
  description: 'Reference to an accounting category',
  fields: (): Record<keyof AccountCategoryReferenceInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The ID of the accounting category',
    },
  }),
});

export const fetchAccountingCategoryWithReference = async (
  input: AccountCategoryReferenceInputFields,
  { loaders = null, throwIfMissing = false } = {},
) => {
  const id = idDecode(input.id, 'accounting-category');
  const category = await (loaders ? loaders.AccountingCategory.byId.load(id) : models.AccountingCategory.findByPk(id));
  if (!category && throwIfMissing) {
    throw new Error(`Accounting category with id ${input.id} not found`);
  }

  return category;
};
