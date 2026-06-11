enum PaymentIntentType {
  // Platform billing
  PlatformBilling = 'PlatformBilling',
  PlatformBillingTipSettlement = 'PlatformBillingTipSettlement',

  // Money out
  GrantRequest = 'GrantRequest',
  PaymentRequest = 'PaymentRequest',
  Charge = 'Charge',

  // Money in
  Contribution = 'Contribution',
  AddedFunds = 'AddedFunds',

  // Transfers
  BalanceTransfer = 'BalanceTransfer',
  InternalTransfer = 'InternalTransfer',

  // Other
  Other = 'Other',
}

export default PaymentIntentType;
