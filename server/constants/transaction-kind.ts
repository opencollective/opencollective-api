export enum TransactionKind {
  /** Transactions coming from the "Add Funds" */
  ADDED_FUNDS = 'ADDED_FUNDS',
  /** Transactions from transferring the remaining balance from a project/event/collective **/
  BALANCE_TRANSFER = 'BALANCE_TRANSFER',
  /** Transactions coming from the "Contribution Flow" */
  CONTRIBUTION = 'CONTRIBUTION',
  /** Transactions coming from the "Expense Flow" */
  EXPENSE = 'EXPENSE',
  /** The host fee going to the Host */
  HOST_FEE = 'HOST_FEE',
  /** Part of the Host fee going from the Host to the Platform */
  HOST_FEE_SHARE = 'HOST_FEE_SHARE',
  /** Part of the Host fee going from the Host to the Platform */
  HOST_FEE_SHARE_DEBT = 'HOST_FEE_SHARE_DEBT',
  /** Amount given by Fiscal Hosts to cover payment processor fee on refunds */
  PAYMENT_PROCESSOR_COVER = 'PAYMENT_PROCESSOR_COVER',
  /** Amount paid by the the Fiscal Host to cover a lost fraud dispute fee */
  PAYMENT_PROCESSOR_DISPUTE_FEE = 'PAYMENT_PROCESSOR_DISPUTE_FEE',
  /** Reserved keyword in case we want to use in the future */
  PAYMENT_PROCESSOR_FEE = 'PAYMENT_PROCESSOR_FEE',
  /** Reserved keyword in case we want to use in the future */
  PLATFORM_FEE = 'PLATFORM_FEE',
  /** Financial contribution to Open Collective added on top of another contribution */
  PLATFORM_TIP = 'PLATFORM_TIP',
  /** Financial contribution to Open Collective added on top of another contribution */
  PLATFORM_TIP_DEBT = 'PLATFORM_TIP_DEBT',
  /** For prepaid budgets */
  PREPAID_PAYMENT_METHOD = 'PREPAID_PAYMENT_METHOD',
  /** For taxes */
  TAX = 'TAX',
}
