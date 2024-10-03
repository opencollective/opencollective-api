/**
 * Constants for the expense status
 *
 *
 * pending -> rejected
 * pending -> approved -> paid
 * pending -> approved -> incomplete -> pending
 *
 * TransferWise:
 * ... -> approved -> processing -> paid
 * ... -> approved -> processing -> error
 *
 * PayPal Payouts:
 * ... -> approved -> scheduled_for_payment -> paid
 * ... -> approved -> scheduled_for_payment -> error
 *
 * Submit on Behalf:
 * draft -> unverified -> pending -> ...
 */

enum ExpenseStatuses {
  DRAFT = 'DRAFT',
  UNVERIFIED = 'UNVERIFIED',
  PENDING = 'PENDING',
  INCOMPLETE = 'INCOMPLETE',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  PROCESSING = 'PROCESSING',
  ERROR = 'ERROR',
  PAID = 'PAID',
  SCHEDULED_FOR_PAYMENT = 'SCHEDULED_FOR_PAYMENT',
  SPAM = 'SPAM',
  CANCELED = 'CANCELED',
  INVITE_DECLINED = 'INVITE_DECLINED',
}

export default ExpenseStatuses;
