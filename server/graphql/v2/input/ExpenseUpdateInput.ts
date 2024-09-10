import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLCurrency } from '../enum';
import { GraphQLExpenseType } from '../enum/ExpenseType';

import { GraphQLAccountingCategoryReferenceInput } from './AccountingCategoryInput';
import { GraphQLNewAccountOrReferenceInput } from './AccountReferenceInput';
import { GraphQLExpenseAttachedFileInput } from './ExpenseAttachedFileInput';
import { GraphQLExpenseItemInput } from './ExpenseItemInput';
import { GraphQLExpenseTaxInput } from './ExpenseTaxInput';
import { GraphQLLocationInput } from './LocationInput';
import { GraphQLPayoutMethodInput } from './PayoutMethodInput';

/**
 * Input type to use as the type for the comment input in editComment mutation.
 */
export const GraphQLExpenseUpdateInput = new GraphQLInputObjectType({
  name: 'ExpenseUpdateInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'ID of the expense that you are trying to edit',
    },
    description: {
      type: GraphQLString,
      description: 'Main title of the expense',
    },
    longDescription: {
      type: GraphQLString,
      description: 'Longer text to attach to the expense',
    },
    reference: {
      type: GraphQLString,
      description: 'User-provided reference number or any other identifier that references the invoice',
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
      type: GraphQLExpenseType,
      description: 'The type of the expense',
    },
    privateMessage: {
      type: GraphQLString,
      description: 'A private note that will be attached to your invoice, as HTML',
    },
    invoiceInfo: {
      type: GraphQLString,
      description: 'Tax ID, VAT number...etc This information will be printed on your invoice.',
    },
    payoutMethod: {
      type: GraphQLPayoutMethodInput,
      description: 'The payout method that will be used to reimburse the expense',
    },
    attachments: {
      type: new GraphQLList(GraphQLExpenseItemInput),
      description:
        '@deprecated 2020-04-08: Please use the items field - The list of items for this expense. Total amount will be computed from them.',
    },
    items: {
      type: new GraphQLList(GraphQLExpenseItemInput),
      description: 'The list of items for this expense. Total amount will be computed from them.',
    },
    attachedFiles: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLExpenseAttachedFileInput)),
      description: '(Optional) A list of files that you want to attach to this expense',
    },
    payee: {
      type: GraphQLNewAccountOrReferenceInput,
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
  }),
});
