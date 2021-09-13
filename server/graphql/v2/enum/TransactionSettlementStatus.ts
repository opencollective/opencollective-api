import { GraphQLEnumType } from 'graphql';

import { TransactionSettlementStatus as TransactionSettlementStatusEnum } from '../../../models/TransactionSettlement';

export const TransactionSettlementStatus = new GraphQLEnumType({
  name: 'TransactionSettlementStatus',
  values: Object.keys(TransactionSettlementStatusEnum).reduce((values, key) => {
    return { ...values, [key]: { value: TransactionSettlementStatusEnum[key] } };
  }, {}),
});
