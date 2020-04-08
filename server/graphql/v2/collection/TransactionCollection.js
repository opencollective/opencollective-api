import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Transaction } from '../interface/Transaction';
import { Collection, CollectionFields } from '../interface/Collection';

export const TransactionCollection = new GraphQLObjectType({
  name: 'TransactionCollection',
  interfaces: [Collection],
  description: 'A collection of Transactions (Debit or Credit)',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Transaction),
      },
    };
  },
});
