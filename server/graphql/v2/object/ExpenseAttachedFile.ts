import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import URL from '../scalar/URL';

const ExpenseAttachedFile = new GraphQLObjectType({
  name: 'ExpenseAttachedFile',
  description: "Fields for an expense's attached file",
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this file',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE_ATTACHED_FILE),
    },
    url: {
      type: URL,
    },
  },
});

export default ExpenseAttachedFile;
