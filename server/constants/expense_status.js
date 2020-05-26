/**
 * Constants for the expense status
 *
 * pending -> rejected
 * pending -> approved -> paid
 * TransferWise:
 * pending -> approved -> processing -> paid
 * pending -> approved -> processing -> error
 * PayPal Payouts:
 * pending -> approved -> scheduled_for_payment -> paid
 * pending -> approved -> scheduled_for_payment -> error
 */

export default {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PROCESSING: 'PROCESSING',
  ERROR: 'ERROR',
  PAID: 'PAID',
  SCHEDULED_FOR_PAYMENT: 'SCHEDULED_FOR_PAYMENT',
};
