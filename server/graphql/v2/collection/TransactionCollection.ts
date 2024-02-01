import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionInterface } from '../../../models/Transaction';
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

type AnyTransactionKind = TransactionKind | `${TransactionKind}`;
type AnyPaymentMethodType = PAYMENT_METHOD_TYPE | `${PAYMENT_METHOD_TYPE}`;

export interface GraphQLTransactionsCollectionReturnType {
  nodes: TransactionInterface[] | Promise<TransactionInterface[]> | (() => Promise<TransactionInterface[]>);
  totalCount: number | Promise<number> | (() => Promise<number>);
  limit: number;
  offset: number;
  kinds?: AnyTransactionKind[] | (() => AnyTransactionKind[]) | (() => Promise<AnyTransactionKind[]>);
  paymentMethodTypes?:
    | AnyPaymentMethodType[]
    | (() => AnyPaymentMethodType[])
    | (() => Promise<AnyPaymentMethodType[]>);
}
