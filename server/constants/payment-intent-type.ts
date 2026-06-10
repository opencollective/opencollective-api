enum PaymentIntentType {
  GrantRequest = 'GrantRequest',
  PaymentRequest = 'PaymentRequest',
  PlatformBillingRequest = 'PlatformBillingRequest',
  PlatformTipSettlementRequest = 'PlatformTipSettlementRequest',
  ManualContributionRequest = 'ManualContributionRequest',
  Contribution = 'Contribution',
  ExpectedContribution = 'ExpectedContribution',
  AddedFunds = 'AddedFunds',
  BalanceTransfer = 'BalanceTransfer',
  LegacyPrepaidPayment = 'LegacyPrepaidPayment',
  Other = 'Other',
}

export default PaymentIntentType;
