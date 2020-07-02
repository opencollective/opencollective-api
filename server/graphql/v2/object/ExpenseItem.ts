import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import URL from '../scalar/URL';

const ExpenseItem = new GraphQLObjectType({
  name: 'ExpenseItem',
  description: 'Fields for an expense item',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this expense item',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE_ITEM),
    },
    amount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Amount of this item',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the item was last updated',
    },
    incurredAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the expense took place',
    },
    description: {
      type: GraphQLString,
      description: 'A description for this item. Enforced for new items, but old expenses may not have one.',
    },
    url: {
      type: URL,
      resolve(item, _, req): string | undefined {
        if (getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, item.ExpenseId)) {
          return item.url;
        }
      },
    },
  },
});

export default ExpenseItem;
