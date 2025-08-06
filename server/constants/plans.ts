export type HostPlan = {
  hostedCollectivesLimit?: number;
  addedFundsLimit?: number;
  bankTransfersLimit?: number;
  transferwisePayoutsLimit?: number;
  manualPayments?: boolean;
  hostDashboard?: boolean;
  hostFees?: boolean;
  hostFeeSharePercent?: number;
  level?: number;
  platformTips?: boolean;
};

const legacyPlans: Record<string, HostPlan> = {
  // Legacy Plans (automatically set for accounts created before 2020)
  'legacy-custom-host-plan': {
    hostedCollectivesLimit: 100,
    addedFundsLimit: 100000, // in dollar cents
    bankTransfersLimit: 100000, // in dollar cents
    transferwisePayoutsLimit: 100000, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 60,
  },
  'legacy-large-host-plan': {
    hostedCollectivesLimit: 25,
    addedFundsLimit: 100000, // in dollar cents
    bankTransfersLimit: 100000, // in dollar cents
    transferwisePayoutsLimit: 100000, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 50,
  },
  'legacy-medium-host-plan': {
    hostedCollectivesLimit: 10,
    addedFundsLimit: 100000, // in dollar cents
    bankTransfersLimit: 100000, // in dollar cents
    transferwisePayoutsLimit: 100000, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 40,
  },
  'legacy-small-host-plan': {
    hostedCollectivesLimit: 5,
    addedFundsLimit: 100000, // in dollar cents
    bankTransfersLimit: 100000, // in dollar cents
    transferwisePayoutsLimit: 100000, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 30,
  },
  'legacy-single-host-plan': {
    hostedCollectivesLimit: 1,
    addedFundsLimit: 100000, // in dollar cents
    bankTransfersLimit: 100000, // in dollar cents
    transferwisePayoutsLimit: 100000, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 20,
  },
  // Plans (for customers from 2020)
  // These keys must match OpenCollective's existing Tier slugs and their data
  // should be updated in our Tier database.
  'network-host-plan': {
    hostedCollectivesLimit: 1000,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 60,
  },
  'large-host-plan': {
    hostedCollectivesLimit: 25,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 50,
  },
  'medium-host-plan': {
    hostedCollectivesLimit: 10,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: false,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 40,
  },
  'small-host-plan': {
    hostedCollectivesLimit: 5,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: false,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 30,
  },
  'single-host-plan': {
    hostedCollectivesLimit: 1,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 20,
  },
  // Special plan for COVID-19 hosts
  'covid-host-plan': {
    hostedCollectivesLimit: 5,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 20,
  },
  // Special plan for everyone without a plan
  default: {
    hostedCollectivesLimit: null,
    addedFundsLimit: 100000, // in dollar cents
    bankTransfersLimit: 100000, // in dollar cents
    transferwisePayoutsLimit: 100000, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 10,
  },
  // Plans for 2021
  'start-plan-2021': {
    hostedCollectivesLimit: null,
    addedFundsLimit: null, // in dollar cents
    bankTransfersLimit: null, // in dollar cents
    transferwisePayoutsLimit: null, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: true,
    hostFees: true,
    hostFeeSharePercent: 15,
    level: 10,
  },
  'grow-plan-2021': {
    hostedCollectivesLimit: null,
    addedFundsLimit: null, // in dollar cents
    bankTransfersLimit: null, // in dollar cents
    transferwisePayoutsLimit: null, // in dollar cents
    manualPayments: true,
    hostDashboard: true,
    platformTips: true,
    hostFees: true,
    hostFeeSharePercent: 15,
    level: 50,
  },
  // Special plan for Open Collective own Hosts
  owned: {
    hostedCollectivesLimit: null,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 100,
  },
  // Special plan for Hosts without limit
  custom: {
    hostedCollectivesLimit: null,
    addedFundsLimit: null,
    bankTransfersLimit: null,
    transferwisePayoutsLimit: null,
    manualPayments: true,
    hostDashboard: true,
    platformTips: false,
    hostFees: true,
    hostFeeSharePercent: 0,
    level: 100,
  },
} as const;

enum PlatformSubscriptionTierTypes {
  FREE = 'Discover',
  BASIC = 'Basic',
  PRO = 'Pro',
}
interface PlatformSubscriptionPlan {
  title: string;
  type: PlatformSubscriptionTierTypes;
  pricing: {
    /** The monthly price in the smallest currency unit (e.g., cents) */
    pricePerMonth: number;

    /** Number of collectives included in this tier */
    includedCollectives: number;

    /** Price for each additional collective beyond the included amount (monthly) */
    pricePerAdditionalCollective: number;

    /** Number of expenses included in this tier */
    includedExpensesPerMonth: number;

    /** Price for each additional expense beyond the included amount (monthly) */
    pricePerAdditionalExpense: number;

    crowdfundingFeePercent?: number;
  };
  features: {
    [x: string]: boolean;
  };
}

const features = {
  // Basic features (all tiers)
  ACCOUNT_MANAGEMENT: 'Account management',
  SUBMIT_REVIEW_EXPENSES: 'Submit and review expenses',
  MANUALLY_PAY_EXPENSES: 'Manually pay expenses',
  UPDATES: 'Updates',
  VENDORS: 'Vendors',
  CROWDFUNDING: 'Crowdfunding',

  // Paid tier features (Basic and Pro)
  PAY_WITH_WISE: 'Pay with Wise',
  PAY_WITH_PAYPAL: 'Pay with PayPal',
  ADVANCED_PERMISSIONS: 'Advanced permissions',
  CHART_OF_ACCOUNTS: 'Chart of accounts',
  HOSTED_COLLECTIVES: 'Hosted collectives',
  ANTIFRAUD_SECURITY: 'Antifraud security checks',
  EXPECTED_FUNDS: 'Expected funds',
  CHARGE_HOSTING_FEES: 'Charge hosting fees',
  RESTRICTED_FUNDS: 'Restricted funds',

  // Pro tier features
  AGREEMENTS: 'Agreements',
  TAX_FORMS: 'Tax forms',
  CONNECT_BANK_ACCOUNTS: 'Connect bank accounts',
  FUNDS_GRANTS_MANAGEMENT: 'Funds & grants management',
};

const freeFeatures = [
  features.ACCOUNT_MANAGEMENT,
  features.SUBMIT_REVIEW_EXPENSES,
  features.MANUALLY_PAY_EXPENSES,
  features.UPDATES,
  features.VENDORS,
  features.CROWDFUNDING,
];

const basicFeatures = [
  ...freeFeatures,
  features.PAY_WITH_WISE,
  features.PAY_WITH_PAYPAL,
  features.ADVANCED_PERMISSIONS,
  features.CHART_OF_ACCOUNTS,
  features.HOSTED_COLLECTIVES,
  features.ANTIFRAUD_SECURITY,
  features.EXPECTED_FUNDS,
  features.CHARGE_HOSTING_FEES,
  features.RESTRICTED_FUNDS,
];

const proFeatures = [
  ...basicFeatures,
  features.AGREEMENTS,
  features.TAX_FORMS,
  features.CONNECT_BANK_ACCOUNTS,
  features.FUNDS_GRANTS_MANAGEMENT,
];

const featuresForStarter = Object.fromEntries(
  Object.values(features).map(feature => [feature, freeFeatures.includes(feature)]),
);

const featuresForBasic = Object.fromEntries(
  Object.values(features).map(feature => [feature, basicFeatures.includes(feature)]),
);

const featuresForPro = Object.fromEntries(
  Object.values(features).map(feature => [feature, proFeatures.includes(feature)]),
);

export const PlatformSubscriptionTiers: PlatformSubscriptionPlan[] = [
  // Free
  {
    title: 'Discover 1',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 0,
      includedCollectives: 1,
      pricePerAdditionalCollective: 999,
      includedExpensesPerMonth: 10,
      pricePerAdditionalExpense: 99,
    },
    features: featuresForStarter,
  },
  {
    title: 'Discover 3',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 1900,
      includedCollectives: 3,
      pricePerAdditionalCollective: 999,
      includedExpensesPerMonth: 30,
      pricePerAdditionalExpense: 99,
    },
    features: featuresForStarter,
  },
  {
    title: 'Discover 5',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 3900,
      includedCollectives: 5,
      pricePerAdditionalCollective: 999,
      includedExpensesPerMonth: 50,
      pricePerAdditionalExpense: 99,
    },
    features: featuresForStarter,
  },
  {
    title: 'Discover 10',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 8900,
      includedCollectives: 10,
      pricePerAdditionalCollective: 999,
      includedExpensesPerMonth: 100,
      pricePerAdditionalExpense: 99,
    },
    features: featuresForStarter,
  },
  // Basic
  {
    title: 'Basic 5',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 4900,
      includedCollectives: 5,
      pricePerAdditionalCollective: 1499,
      includedExpensesPerMonth: 50,
      pricePerAdditionalExpense: 149,
    },
    features: featuresForBasic,
  },
  {
    title: 'Basic 10',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 12900,
      includedCollectives: 10,
      pricePerAdditionalCollective: 1499,
      includedExpensesPerMonth: 100,
      pricePerAdditionalExpense: 149,
    },
    features: featuresForBasic,
  },
  {
    title: 'Basic 20',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 26900,
      includedCollectives: 20,
      pricePerAdditionalCollective: 1499,
      includedExpensesPerMonth: 200,
      pricePerAdditionalExpense: 149,
    },
    features: featuresForBasic,
  },
  {
    title: 'Basic 50',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 64900,
      includedCollectives: 50,
      pricePerAdditionalCollective: 1499,
      includedExpensesPerMonth: 500,
      pricePerAdditionalExpense: 149,
    },
    features: featuresForBasic,
  },
  // Pro
  {
    title: 'Pro 20',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 34900,
      includedCollectives: 20,
      pricePerAdditionalCollective: 1999,
      includedExpensesPerMonth: 200,
      pricePerAdditionalExpense: 199,
    },
    features: featuresForPro,
  },
  {
    title: 'Pro 50',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 89900,
      includedCollectives: 50,
      pricePerAdditionalCollective: 1999,
      includedExpensesPerMonth: 500,
      pricePerAdditionalExpense: 199,
    },
    features: featuresForPro,
  },
  {
    title: 'Pro 100',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 179900,
      includedCollectives: 100,
      pricePerAdditionalCollective: 1999,
      includedExpensesPerMonth: 1000,
      pricePerAdditionalExpense: 199,
    },
    features: featuresForPro,
  },
  {
    title: 'Pro 200',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 349900,
      includedCollectives: 200,
      pricePerAdditionalCollective: 1999,
      includedExpensesPerMonth: 2000,
      pricePerAdditionalExpense: 199,
    },
    features: featuresForPro,
  },
];

export default legacyPlans;
