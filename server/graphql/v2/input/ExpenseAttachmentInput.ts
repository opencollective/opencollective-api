import { GraphQLString, GraphQLInt, GraphQLInputObjectType } from 'graphql';
import { DateString } from '../../v1/types';

/**
 * To create or edit an expense attachment
 */
export const ExpenseAttachmentInput = new GraphQLInputObjectType({
  name: 'ExpenseAttachmentInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'ID of the attachment',
    },
    amount: {
      type: GraphQLInt,
      description: 'Amount in cents',
    },
    description: {
      type: GraphQLString,
      description: 'What is this attachment about?',
    },
    url: {
      type: GraphQLString,
      description: 'URL of the file linked to this attachment. Must be provided if the expense type is RECEIPT.',
    },
    incurredAt: {
      type: DateString,
      description: 'When was the money spent?',
    },
  },
});
