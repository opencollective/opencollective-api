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
  /**
   * Setting this status authorizes a payment: the hourly cron pays PayPal payouts in this status without anyone else
   * involved. Only `scheduleExpenseForPayment` should set it, as it checks permissions, balance and 2FA (see
   * `enforcePayout2FA`). Before paying, the cron also checks that the admin who scheduled the payout (from the
   * `COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT` activity) is still an admin of the host.
   */
  SCHEDULED_FOR_PAYMENT = 'SCHEDULED_FOR_PAYMENT',
  SPAM = 'SPAM',
  CANCELED = 'CANCELED',
  INVITE_DECLINED = 'INVITE_DECLINED',
}

export default ExpenseStatuses;
