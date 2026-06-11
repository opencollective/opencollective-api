enum PaymentIntentLedgerScope {
  /** Money moved across fiscal host or account boundaries (e.g. credit card donation, PayPal payout...etc.). */
  EXTERNAL = 'EXTERNAL',
  /** Money moved between accounts hosted by the same fiscal host, but not in a parent/child hierarchy (e.g. transfer between collectives hosted by the same fiscal host, or money paid by the collective to its fiscal host). */
  FISCAL_HOST = 'FISCAL_HOST',
  /** Money moved between accounts in a parent/child hierarchy (e.g. transfer between a collective and an event/project). */
  ACCOUNT_HIERARCHY = 'ACCOUNT_HIERARCHY',
}

export default PaymentIntentLedgerScope;
