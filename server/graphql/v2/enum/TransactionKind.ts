import { GraphQLEnumType } from 'graphql';

import { TransactionKind as TransactionKindEnum } from '.././../../constants/transaction-kind';

export const GraphQLTransactionKind = new GraphQLEnumType({
  name: 'TransactionKind',
  values: Object.keys(TransactionKindEnum).reduce((values, key) => {
    return { ...values, [key]: { value: TransactionKindEnum[key] } };
  }, {}),
});
