import { GraphQLEnumType } from 'graphql';

import { RefundKind as RefundKindEnum } from '../../../constants/refund-kind';

export const GraphQLRefundKind = new GraphQLEnumType({
  name: 'RefundKind',
  values: {
    [RefundKindEnum.REFUND]: {
      description: 'Refund issued by the host',
    },
    [RefundKindEnum.REJECT]: {
      description: 'Rejection issued by the host or collective admin',
    },
    [RefundKindEnum.EDIT]: {
      description: 'Transaction reversed due to an edit',
    },
    [RefundKindEnum.DUPLICATE]: {
      description: 'Transaction was refunded by the platform to fix a duplicated transaction',
    },
    [RefundKindEnum.DISPUTE]: {
      description: 'Transaction was refunded due to a dispute',
    },
  } as Record<RefundKindEnum, { description: string }>,
});
