enum PaymentIntentType {
  // Platform billing
  PlatformBilling = 'PlatformBilling',
  PlatformBillingTipSettlement = 'PlatformBillingTipSettlement',

  // Money out
  GrantRequest = 'GrantRequest',
  PaymentRequest = 'PaymentRequest',
  CardCharge = 'CardCharge',

  // Money in
  Contribution = 'Contribution',
  AddedMoney = 'AddedMoney',

  // Transfers
  BalanceTransfer = 'BalanceTransfer',
  InternalTransfer = 'InternalTransfer',

  // Other
  Other = 'Other',
}

export default PaymentIntentType;
