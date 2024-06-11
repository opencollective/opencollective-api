import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLTransactionsImportRow } from '../object/TransactionsImportRow';

export const GraphQLTransactionsImportRowCollection = new GraphQLObjectType({
  name: 'TransactionsImportRowCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "TransactionsImportRow"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportRow)),
      },
    };
  },
});
