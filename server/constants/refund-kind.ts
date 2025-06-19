export enum RefundKind {
  /** Refund issued by the host */
  REFUND = 'REFUND',
  /** Rejection issued by the host or collective admin */
  REJECT = 'REJECT',
  /** Transaction reversed due to an edit */
  EDIT = 'EDIT',
  /** Transaction was returned by the platform to fix a duplicated transaction */
  DUPLICATE = 'DUPLICATE',
  /** Transaction was refunded due to a dispute */
  DISPUTE = 'DISPUTE',
}
