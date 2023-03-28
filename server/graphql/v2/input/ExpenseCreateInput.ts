import {
  GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { Currency } from '../enum';
import { ExpenseType } from '../enum/ExpenseType';

import { AccountReferenceInput } from './AccountReferenceInput';
import { ExpenseAttachedFileInput } from './ExpenseAttachedFileInput';
import { ExpenseItemCreateInput } from './ExpenseItemCreateInput';
import { ExpenseTaxInput } from './ExpenseTaxInput';
import { LocationInput } from './LocationInput';
import { PayoutMethodInput } from './PayoutMethodInput';

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
    type: Currency,
    description: 'Currency that should be used for the payout. Defaults to the account currency',
  },
  tags: {
    type: new GraphQLList(GraphQLString),
    description: 'Tags associated to the expense (ie. Food, Engineering...)',
  },
  type: {
    type: new GraphQLNonNull(ExpenseType),
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
    type: new GraphQLNonNull(PayoutMethodInput),
    description: 'The payout method that will be used to reimburse the expense',
  },
  items: {
    type: new GraphQLList(ExpenseItemCreateInput),
    description: 'The list of items for this expense. Total amount will be computed from them.',
  },
  attachedFiles: {
    type: new GraphQLList(new GraphQLNonNull(ExpenseAttachedFileInput)),
    description: '(Optional) A list of files that you want to attach to this expense',
  },
  payee: {
    type: new GraphQLNonNull(AccountReferenceInput),
    description: 'Account to reimburse',
  },
  payeeLocation: {
    type: LocationInput,
    description: 'The address of the payee',
  },
  tax: {
    type: new GraphQLList(ExpenseTaxInput),
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
export const ExpenseCreateInput = new GraphQLInputObjectType({
  name: 'ExpenseCreateInput',
  fields: getExpenseCreateInputFields,
});
