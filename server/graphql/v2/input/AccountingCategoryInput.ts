import {
  GraphQLBoolean,
  GraphQLInputFieldConfig,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import ExpenseTypes from '../../../constants/expense-type';
import { TransactionKind } from '../../../constants/transaction-kind';
import models from '../../../models';
import { AccountingCategoryAppliesTo, AccountingCategoryKind } from '../../../models/AccountingCategory';
import { GraphQLAccountingCategoryAppliesTo } from '../enum/AccountingCategoryAppliesTo';
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
  hostOnly?: boolean;
  instructions?: string;
  appliesTo?: AccountingCategoryAppliesTo;
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
    hostOnly: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: false,
      description: 'Whether this category is only meant for the host admins',
    },
    instructions: {
      type: GraphQLString,
    },
    expensesTypes: {
      type: new GraphQLList(GraphQLExpenseType),
      description: 'If meant for expenses, the types of expenses this category applies to',
    },
    appliesTo: {
      type: GraphQLAccountingCategoryAppliesTo,
      description: 'If the category is applicable to the Host or Hosted Collectives, or both if null',
    },
  }),
});

// Reference

export type GraphQLAccountingCategoryReferenceInputFields = {
  publicId?: string;
  id?: string;
};

/**
 * Only `id` is used at the moment, but we're implementing this as a reference type as we may want
 * to support fetching with a combination of `account` + `code` in the future.
 */
export const GraphQLAccountingCategoryReferenceInput = new GraphQLInputObjectType({
  name: 'AccountingCategoryReferenceInput',
  description: 'Reference to an accounting category',
  fields: (): Record<keyof GraphQLAccountingCategoryReferenceInputFields, GraphQLInputFieldConfig> => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${models.AccountingCategory.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The ID of the accounting category',
      deprecationReason: '2026-02-25: use publicId',
    },
  }),
});

export const fetchAccountingCategoryWithReference = async (
  input: GraphQLAccountingCategoryReferenceInputFields,
  { loaders = null, throwIfMissing = false } = {},
) => {
  let category;
  if (input.publicId) {
    const expectedPrefix = models.AccountingCategory.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for AccountingCategory, expected prefix ${expectedPrefix}_`);
    }

    category = await models.AccountingCategory.findOne({ where: { publicId: input.publicId } });
  } else if (input.id) {
    const id = idDecode(input.id, 'accounting-category');
    category = await (loaders ? loaders.AccountingCategory.byId.load(id) : models.AccountingCategory.findByPk(id));
  }
  if (!category && throwIfMissing) {
    throw new Error(`Accounting category with id ${input.id} not found`);
  }

  return category;
};
