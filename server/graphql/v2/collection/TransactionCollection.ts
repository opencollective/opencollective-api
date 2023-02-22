import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { GraphQLPaymentMethodType } from '../enum/PaymentMethodType';
import { GraphQLTransactionKind } from '../enum/TransactionKind';
import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLTransaction } from '../interface/Transaction';

export const GraphQLTransactionCollection = new GraphQLObjectType({
  name: 'TransactionCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of Transactions (Debit or Credit)',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLTransaction),
    },
    kinds: {
      type: new GraphQLList(GraphQLTransactionKind),
    },
    paymentMethodTypes: {
      type: new GraphQLNonNull(new GraphQLList(GraphQLPaymentMethodType)),
      description: 'The types of payment methods used in this collection, regardless of the pagination',
    },
  }),
});
