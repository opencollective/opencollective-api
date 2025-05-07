import { GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';

export const GraphQLTransactionsImportStats = new GraphQLObjectType({
  name: 'TransactionsImportStats',
  fields: {
    total: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Total number of rows in the import',
    },
    ignored: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that have been ignored',
    },
    expenses: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that have been converted to expenses',
    },
    orders: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that have been converted to orders',
    },
    processed: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that have been processed (either dismissed or converted to expenses or orders)',
    },
    imported: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that have been imported (converted to expenses or orders)',
    },
    onHold: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that are on hold',
    },
    pending: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that are pending',
    },
    invalid: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Number of rows that are invalid (e.g. linked but without an expense or order)',
    },
  },
});
