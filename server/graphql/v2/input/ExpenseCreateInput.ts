import {
  GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLExpenseType } from '../enum/ExpenseType.js';
import { GraphQLCurrency } from '../enum/index.js';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput.js';
import { GraphQLExpenseAttachedFileInput } from './ExpenseAttachedFileInput.js';
import { GraphQLExpenseItemCreateInput } from './ExpenseItemCreateInput.js';
import { GraphQLExpenseTaxInput } from './ExpenseTaxInput.js';
import { GraphQLLocationInput } from './LocationInput.js';
import { GraphQLPayoutMethodInput } from './PayoutMethodInput.js';

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
    description: 'A private note that will be attached to your invoice, as HTML',
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
});

/**
 * Input type to use as the type for the expense input in createExpense mutation.
 */
export const GraphQLExpenseCreateInput = new GraphQLInputObjectType({
  name: 'ExpenseCreateInput',
  fields: getExpenseCreateInputFields,
});
