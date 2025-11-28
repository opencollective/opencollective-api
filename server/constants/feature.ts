enum FEATURE {
  /** Wildcard feature used to freeze and unfreeze collectives */
  ALL = 'ALL',
  /** Whether people can financially contribute to this initiative */
  RECEIVE_FINANCIAL_CONTRIBUTIONS = 'RECEIVE_FINANCIAL_CONTRIBUTIONS',
  /** Whether this profile can make recurring contributions */
  RECURRING_CONTRIBUTIONS = 'RECURRING_CONTRIBUTIONS',
  /** Whether this profile has any transaction */
  TRANSACTIONS = 'TRANSACTIONS',
  /** Whether this profile can have events */
  EVENTS = 'EVENTS',
  /** Whether this profile can have projects */
  PROJECTS = 'PROJECTS',
  /** Whether this profile can submit expenses */
  USE_EXPENSES = 'USE_EXPENSES',
  /** Whether this profile can receive expenses */
  RECEIVE_EXPENSES = 'RECEIVE_EXPENSES',
  /** Whether this account can use multi-currency expenses */
  MULTI_CURRENCY_EXPENSES = 'MULTI_CURRENCY_EXPENSES',
  /** Whether this profile can create "goals" (displayed on the collective page) */
  COLLECTIVE_GOALS = 'COLLECTIVE_GOALS',
  /**
   * Whether this profile has the "top contributors" section enabled.
   */
  TOP_FINANCIAL_CONTRIBUTORS = 'TOP_FINANCIAL_CONTRIBUTORS',
  /** Whether this profile can host conversations */
  CONVERSATIONS = 'CONVERSATIONS',
  /** Whether this profile can host updates */
  UPDATES = 'UPDATES',
  /**
   * Whether this profile can have a long description
   */
  ABOUT = 'ABOUT',
  /**
   * Whether this profile has the "team" section displayed
   */
  TEAM = 'TEAM',
  /**
   * Whether user can create orders.
   * TODO: This is a user feature, not a collective feature. We should separate the two
   */
  ORDER = 'ORDER',
  /** Whether this profile can be contacted via the redirect email */
  CONTACT_COLLECTIVE = 'CONTACT_COLLECTIVE',
  /** Whether this profile can be contacted via the contact form */
  CONTACT_FORM = 'CONTACT_FORM',
  /**
   * Whether user can create collectives.
   * TODO: This is a user feature, not a collective feature. We should separate the two
   */
  CREATE_COLLECTIVE = 'CREATE_COLLECTIVE',
  /** Whether this profile has paypal donations enabled */
  PAYPAL_DONATIONS = 'PAYPAL_DONATIONS',
  /** Whether this profile has its host dashboard enabled */
  HOST_DASHBOARD = 'HOST_DASHBOARD',
  /** Whether this profile has connected accounts */
  CONNECTED_ACCOUNTS = 'CONNECTED_ACCOUNTS',
  /** Whether this profile can receive donations using AliPay */
  ALIPAY = 'ALIPAY',
  /** Wheter this profile accepts SEPA or ACH payments through Stripe */
  STRIPE_PAYMENT_INTENT = 'STRIPE_PAYMENT_INTENT',

  /** Whether an account can add and use payment methods */
  USE_PAYMENT_METHODS = 'USE_PAYMENT_METHODS',

  /** Whether an account can emit gift cards */
  EMIT_GIFT_CARDS = 'EMIT_GIFT_CARDS',

  /** @deprecated Whether an account tweak email notifications or not */
  EMAIL_NOTIFICATIONS_PANEL = 'EMAIL_NOTIFICATIONS_PANEL',

  /** Virtual Cards */
  // Whether this profile can assign virtual cards
  VIRTUAL_CARDS = 'VIRTUAL_CARDS',
  // Whether this profile can request a virtual card
  REQUEST_VIRTUAL_CARDS = 'REQUEST_VIRTUAL_CARDS',

  /** Whether an account can use Plaid/GoCardless */
  OFF_PLATFORM_TRANSACTIONS = 'OFF_PLATFORM_TRANSACTIONS',

  /** Whether this profile has transferwise enabled */
  TRANSFERWISE = 'TRANSFERWISE',
  /** Whether this profile has paypal payouts enabled */
  PAYPAL_PAYOUTS = 'PAYPAL_PAYOUTS',
  /** Whether this profile can receive host applications */
  RECEIVE_HOST_APPLICATIONS = 'RECEIVE_HOST_APPLICATIONS',

  CHART_OF_ACCOUNTS = 'CHART_OF_ACCOUNTS',
  EXPENSE_SECURITY_CHECKS = 'EXPENSE_SECURITY_CHECKS',
  EXPECTED_FUNDS = 'EXPECTED_FUNDS',
  CHARGE_HOSTING_FEES = 'CHARGE_HOSTING_FEES',
  AGREEMENTS = 'AGREEMENTS',
  TAX_FORMS = 'TAX_FORMS',
  FUNDS_GRANTS_MANAGEMENT = 'FUNDS_GRANTS_MANAGEMENT',
  VENDORS = 'VENDORS',
  ACCOUNT_MANAGEMENT = 'ACCOUNT_MANAGEMENT',
  KYC = 'KYC',
}

// features that can conditionally enabled/disabled based on subscription
export const CommercialFeatures = [
  FEATURE.TRANSFERWISE,
  FEATURE.PAYPAL_PAYOUTS,
  FEATURE.RECEIVE_HOST_APPLICATIONS,
  FEATURE.CHART_OF_ACCOUNTS,
  FEATURE.EXPENSE_SECURITY_CHECKS,
  FEATURE.EXPECTED_FUNDS,
  FEATURE.CHARGE_HOSTING_FEES,
  FEATURE.AGREEMENTS,
  FEATURE.TAX_FORMS,
  FEATURE.FUNDS_GRANTS_MANAGEMENT,
  FEATURE.VENDORS,
  FEATURE.USE_EXPENSES,
  FEATURE.UPDATES,
  FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS,
  FEATURE.RECEIVE_EXPENSES,
  FEATURE.ACCOUNT_MANAGEMENT,
  FEATURE.OFF_PLATFORM_TRANSACTIONS,
  FEATURE.KYC,
] as const;

/**
 * A map of labels and documentation URLs for features; mostly used to build the emails.
 */
export const FeatureDetails: Record<CommercialFeaturesType, { label: string; documentationUrl: string | null }> = {
  TRANSFERWISE: {
    label: 'Payouts with Wise',
    documentationUrl: 'https://documentation.opencollective.com/fiscal-hosts/expense-payment/paying-expenses-with-wise',
  },
  PAYPAL_PAYOUTS: {
    label: 'Payouts with PayPal',
    documentationUrl:
      'https://documentation.opencollective.com/fiscal-hosts/expense-payment/paying-expenses-with-paypal',
  },
  RECEIVE_HOST_APPLICATIONS: {
    label: 'Receive Host Applications',
    documentationUrl:
      'https://documentation.opencollective.com/fiscal-hosts/managing-your-collectives/collective-applications',
  },
  CHART_OF_ACCOUNTS: {
    label: 'Chart of Accounts',
    documentationUrl: 'https://documentation.opencollective.com/fiscal-hosts/chart-of-accounts',
  },
  EXPENSE_SECURITY_CHECKS: {
    label: 'Expense Security Checks',
    documentationUrl:
      'https://documentation.opencollective.com/fiscal-hosts/expense-payment/understanding-security-checks',
  },
  EXPECTED_FUNDS: {
    label: 'Expected Funds',
    documentationUrl: 'https://documentation.opencollective.com/fiscal-hosts/receiving-money/pending-contributions',
  },
  CHARGE_HOSTING_FEES: {
    label: 'Charge Hosting Fees',
    documentationUrl:
      'https://documentation.opencollective.com/fiscal-hosts/setting-up-a-fiscal-host/setting-your-fiscal-host-fees',
  },
  AGREEMENTS: {
    label: 'Agreements',
    documentationUrl: 'https://documentation.opencollective.com/fiscal-hosts/managing-your-collectives/agreements',
  },
  TAX_FORMS: {
    label: 'Tax Forms',
    documentationUrl:
      'https://documentation.opencollective.com/expenses-and-getting-paid/understanding-tax-requirements',
  },
  FUNDS_GRANTS_MANAGEMENT: {
    label: 'Funds & Grants Management',
    documentationUrl: 'https://documentation.opencollective.com/fiscal-hosts/funds-and-grants/funds',
  },
  VENDORS: {
    label: 'Vendors',
    documentationUrl: 'https://documentation.opencollective.com/fiscal-hosts/managing-your-collectives/vendors',
  },
  USE_EXPENSES: {
    label: 'Submit Expenses',
    documentationUrl: 'https://documentation.opencollective.com/expenses-and-getting-paid/submitting-expenses',
  },
  UPDATES: {
    label: 'Updates',
    documentationUrl:
      'https://documentation.opencollective.com/advanced/keeping-your-community-updated/updates-and-contact',
  },
  RECEIVE_FINANCIAL_CONTRIBUTIONS: {
    label: 'Receive Financial Contributions',
    documentationUrl: null,
  },
  RECEIVE_EXPENSES: {
    label: 'Receive Expenses',
    documentationUrl:
      'https://documentation.opencollective.com/fiscal-hosts/expense-payment/paying-expenses-as-a-fiscal-host',
  },
  ACCOUNT_MANAGEMENT: {
    label: 'Account Management',
    documentationUrl: null,
  },
  OFF_PLATFORM_TRANSACTIONS: {
    label: 'Synchronize Bank Accounts',
    documentationUrl: null,
  },
  KYC: {
    label: 'KYC',
    documentationUrl: null,
  },
} as const;

export type CommercialFeaturesType = (typeof CommercialFeatures)[number];

export const FeaturesList = Object.values(FEATURE);

export default FEATURE;
