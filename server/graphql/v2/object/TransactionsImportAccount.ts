import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

export const GraphQLTransactionsImportAccount = new GraphQLObjectType({
  name: 'TransactionsImportAccount',
  description: 'An account available in a transactions import (Plaid or GoCardless)',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The unique identifier for the account',
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The name of the account',
    },
    // Plaid-specific fields
    subtype: {
      type: GraphQLString,
      description: 'The subtype of the account (Plaid only)',
    },
    type: {
      type: GraphQLString,
      description: 'The type of the account (Plaid only)',
    },
    mask: {
      type: GraphQLString,
      description: 'The mask of the account (Plaid only)',
    },
  }),
});
