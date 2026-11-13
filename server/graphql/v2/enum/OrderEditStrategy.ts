import { GraphQLEnumType } from 'graphql';

import { OrderEditStrategy } from '../../../lib/edit-order-transactions';

export const GraphQLOrderEditStrategy = new GraphQLEnumType({
  name: 'OrderEditStrategy',
  description: 'How the ledger is updated when editing funds that were recorded manually by a host admin',
  values: {
    [OrderEditStrategy.REVERSE]: {
      description:
        'Reverse the existing transactions and record new ones. The ledger keeps track of the previous values.',
    },
    [OrderEditStrategy.IN_PLACE]: {
      description:
        'Replace the existing transactions with the new values, without recording a reversal. Transactions that were already exported or reconciled will not match the ledger anymore.',
    },
  } as Record<OrderEditStrategy, { description: string }>,
});
