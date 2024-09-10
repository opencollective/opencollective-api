import {
  GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLCurrency } from '../enum';
import { GraphQLExpenseType } from '../enum/ExpenseType';

import { GraphQLAccountingCategoryReferenceInput } from './AccountingCategoryInput';
import { GraphQLAccountReferenceInput } from './AccountReferenceInput';
import { GraphQLExpenseAttachedFileInput } from './ExpenseAttachedFileInput';
import { GraphQLExpenseItemCreateInput } from './ExpenseItemCreateInput';
import { GraphQLExpenseTaxInput } from './ExpenseTaxInput';
import { GraphQLLocationInput } from './LocationInput';
import { GraphQLPayoutMethodInput } from './PayoutMethodInput';

export const getExpenseCreateInputFields = (): GraphQLInputFieldConfigMap => ({
  description: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'Main title of the expense',
  },
  longDescription: {
    type: GraphQLString,
    description: 'Longer text to attach to the expense',
  },
  currency: {
    type: GraphQLCurrency,
    description: 'Currency that should be used for the payout. Defaults to the account currency',
  },
  tags: {
    type: new GraphQLList(GraphQLString),
    description: 'Tags associated to the expense (ie. Food, Engineering...)',
  },
  type: {
    type: new GraphQLNonNull(GraphQLExpenseType),
    description: 'The type of the expense',
  },
  privateMessage: {
    type: GraphQLString,
    description:
      'A private note that will be attached to your invoice, as HTML. Only visible to the payee and the collective/host admins.',
  },
  invoiceInfo: {
    type: GraphQLString,
    description: 'Custom information to print on the invoice',
  },
  payoutMethod: {
    type: new GraphQLNonNull(GraphQLPayoutMethodInput),
    description: 'The payout method that will be used to reimburse the expense',
  },
  items: {
    type: new GraphQLList(GraphQLExpenseItemCreateInput),
    description: 'The list of items for this expense. Total amount will be computed from them.',
  },
  attachedFiles: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLExpenseAttachedFileInput)),
    description: '(Optional) A list of files that you want to attach to this expense',
  },
  payee: {
    type: new GraphQLNonNull(GraphQLAccountReferenceInput),
    description: 'Account to reimburse',
  },
  payeeLocation: {
    type: GraphQLLocationInput,
    description: 'The address of the payee',
  },
  tax: {
    type: new GraphQLList(GraphQLExpenseTaxInput),
    description: 'The list of taxes that should be applied to the expense (VAT, GST, etc...)',
  },
  customData: {
    type: GraphQLJSON,
    description: 'Custom data to be stored in the expense',
  },
  accountingCategory: {
    type: GraphQLAccountingCategoryReferenceInput,
    description: 'The accounting category this expense belongs to',
  },
  reference: {
    type: GraphQLString,
    description: 'User-provided reference number or any other identifier that references the invoice',
  },
});

/**
 * Input type to use as the type for the expense input in createExpense mutation.
 */
export const GraphQLExpenseCreateInput = new GraphQLInputObjectType({
  name: 'ExpenseCreateInput',
  fields: getExpenseCreateInputFields,
});
