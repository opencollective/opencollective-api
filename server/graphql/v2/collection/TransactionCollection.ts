import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { PaymentMethodType } from '../enum/PaymentMethodType';
import { TransactionKind } from '../enum/TransactionKind';
import { Collection, CollectionFields } from '../interface/Collection';
import { Transaction } from '../interface/Transaction';

export const TransactionCollection = new GraphQLObjectType({
  name: 'TransactionCollection',
  interfaces: [Collection],
  description: 'A collection of Transactions (Debit or Credit)',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(Transaction),
    },
    kinds: {
      type: new GraphQLList(TransactionKind),
    },
    paymentMethodTypes: {
      type: new GraphQLNonNull(new GraphQLList(PaymentMethodType)),
      description: 'The types of payment methods used in this collection, regardless of the pagination',
    },
  }),
});
