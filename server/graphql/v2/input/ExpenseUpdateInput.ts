import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { ExpenseType } from '../enum/ExpenseType';

import { AccountReferenceInput } from './AccountReferenceInput';
import { ExpenseAttachedFileInput } from './ExpenseAttachedFileInput';
import { ExpenseItemInput } from './ExpenseItemInput';
import { LocationInput } from './LocationInput';
import { PayoutMethodInput } from './PayoutMethodInput';

/**
 * Input type to use as the type for the comment input in editComment mutation.
 */
export const ExpenseUpdateInput = new GraphQLInputObjectType({
  name: 'ExpenseUpdateInput',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'ID of the expense that you are trying to edit',
    },
    description: {
      type: GraphQLString,
      description: 'Main title of the expense',
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      description: 'Tags associated to the expense (ie. Food, Engineering...)',
    },
    type: {
      type: ExpenseType,
      description: 'The type of the expense',
    },
    privateMessage: {
      type: GraphQLString,
      description: 'A private note that will be attached to your invoice',
    },
    invoiceInfo: {
      type: GraphQLString,
      description: 'Tax ID, VAT number...etc This information will be printed on your invoice.',
    },
    payoutMethod: {
      type: PayoutMethodInput,
      description: 'The payout method that will be used to reimburse the expense',
    },
    attachments: {
      type: new GraphQLList(ExpenseItemInput),
      description:
        '@deprecated 2020-04-08: Please use the items field - The list of items for this expense. Total amount will be computed from them.',
    },
    items: {
      type: new GraphQLList(ExpenseItemInput),
      description: 'The list of items for this expense. Total amount will be computed from them.',
    },
    attachedFiles: {
      type: new GraphQLList(new GraphQLNonNull(ExpenseAttachedFileInput)),
      description: '(Optional) A list of files that you want to attach to this expense',
    },
    payee: {
      type: AccountReferenceInput,
      description: 'Account to reimburse',
    },
    payeeLocation: {
      type: LocationInput,
      description: 'The address of the payee',
    },
  },
});
