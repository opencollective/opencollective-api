import { GraphQLString, GraphQLInputObjectType, GraphQLNonNull, GraphQLList } from 'graphql';
import { ExpenseType } from '../enum/ExpenseType';
import { PayoutMethodInput } from './PayoutMethodInput';
import { ExpenseAttachmentInput } from './ExpenseAttachmentInput';
import { AccountReferenceInput } from './AccountReferenceInput';

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
      type: new GraphQLList(ExpenseAttachmentInput),
      description: 'The list of attachments for this expense. Total amount will be computed from them.',
    },
    payee: {
      type: AccountReferenceInput,
      description: 'Account to reimburse',
    },
  },
});
