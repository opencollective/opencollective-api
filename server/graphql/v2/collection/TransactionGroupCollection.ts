import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLTransactionGroup } from '../object/TransactionGroup';

export const GraphQLTransactionGroupCollection = new GraphQLObjectType({
  name: 'TransactionGroupCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of Transactions groups',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLTransactionGroup))),
    },
  }),
});
