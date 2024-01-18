import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import ExpenseTypes from '../../../constants/expense_type';
import { TransactionKind } from '../../../constants/transaction-kind';
import models from '../../../models';
import { AccountingCategoryKind } from '../../../models/AccountingCategory';
import { GraphQLAccountingCategoryKind } from '../enum/AccountingCategoryKind';
import { GraphQLExpenseType } from '../enum/ExpenseType';
import { idDecode } from '../identifiers';

export type AccountingCategoryInputFields = {
  id?: string;
  code?: string;
  name?: string;
  friendlyName?: string;
  expensesTypes?: ExpenseTypes[];
  kind?: AccountingCategoryKind;
};

export const AccountingCategoryInput = new GraphQLInputObjectType({
  name: 'AccountingCategoryInput',
  description: 'Input for creating or updating an account category',
  fields: (): Record<keyof AccountingCategoryInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: GraphQLNonEmptyString,
      description: 'The ID of the accounting category to edit',
    },
    kind: {
      type: new GraphQLNonNull(GraphQLAccountingCategoryKind),
      defaultValue: TransactionKind.EXPENSE,
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

export type GraphQLAccountingCategoryReferenceInputFields = {
  id: string;
};

/**
 * Only `id` is used at the moment, but we're implementing this as a reference type as we may want
 * to support fetching with a combination of `account` + `code` in the future.
 */
export const GraphQLAccountingCategoryReferenceInput = new GraphQLInputObjectType({
  name: 'AccountingCategoryReferenceInput',
  description: 'Reference to an accounting category',
  fields: (): Record<keyof GraphQLAccountingCategoryReferenceInputFields, GraphQLInputFieldConfig> => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The ID of the accounting category',
    },
  }),
});

export const fetchAccountingCategoryWithReference = async (
  input: GraphQLAccountingCategoryReferenceInputFields,
  { loaders = null, throwIfMissing = false } = {},
) => {
  const id = idDecode(input.id, 'accounting-category');
  const category = await (loaders ? loaders.AccountingCategory.byId.load(id) : models.AccountingCategory.findByPk(id));
  if (!category && throwIfMissing) {
    throw new Error(`Accounting category with id ${input.id} not found`);
  }

  return category;
};
