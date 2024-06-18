import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLTransactionsImport } from '../object/TransactionsImport';

export const GraphQLTransactionsImportsCollection = new GraphQLObjectType({
  name: 'TransactionsImportsCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "TransactionsImports"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImport)),
      },
    };
  },
});
