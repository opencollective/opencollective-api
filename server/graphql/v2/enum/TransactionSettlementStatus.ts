import { GraphQLEnumType } from 'graphql';

import { TransactionSettlementStatus as TransactionSettlementStatusEnum } from '../../../models/TransactionSettlement.js';

export const GraphQLTransactionSettlementStatus = new GraphQLEnumType({
  name: 'TransactionSettlementStatus',
  values: Object.keys(TransactionSettlementStatusEnum).reduce((values, key) => {
    return { ...values, [key]: { value: TransactionSettlementStatusEnum[key] } };
  }, {}),
});
