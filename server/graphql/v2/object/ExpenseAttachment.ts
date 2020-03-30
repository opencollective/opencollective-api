import { GraphQLString, GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

const ExpenseAttachment = new GraphQLObjectType({
  name: 'ExpenseAttachment',
  description: 'Fields for an expense attachment',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this expense attachment',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE_ATTACHMENT),
    },
    amount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Amount of this attachment',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the attachment was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the attachment was last updated',
    },
    incurredAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the expense took place',
    },
    description: {
      type: GraphQLString,
      description: 'A description for this attachment. Enforced for new items, but old expenses may not have one.',
    },
    url: {
      type: GraphQLString,
      resolve(attachment, _, req): string | undefined {
        if (getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, attachment.ExpenseId)) {
          return attachment.url;
        }
      },
    },
  },
});

export default ExpenseAttachment;
