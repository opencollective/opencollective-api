export default class TransactionWorld {
  constructor() {
    this.state = {
      hostOwner: null,
      host: null,
      collective: null,
    };
  }

  set = (newState) => {
    this.state = {
      ...this.state,
      ...newState
    };
  }

  calculateFees = () => {
    return 0;
  }

  calculateFeeDetails = () => {
    return [
      // { amount: 175, currency, type: "stripe_fee" },
      // { amount: 250, currency, type: "application_fee" }
    ];
  }

  createRetrieveBalanceTransactionStub = (amount, currency) => () => Promise.resolve({
    id: "txn_1Bs9EEBYycQg1OMfTR33Y5Xr",
    object: "balance_transaction",
    amount,
    currency,
    fee: this.calculateFees(),
    fee_details: this.calculateFeeDetails(),
    net: amount - this.calculateFees(),
    status: "pending",
    type: "charge",
  });
}
