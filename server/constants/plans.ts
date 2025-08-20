import { CommercialFeatures, CommercialFeaturesType, default as PlatformFeature } from './feature';

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
export interface PlatformSubscriptionPlan {
  id: string;
  title: string;
  type: PlatformSubscriptionTierTypes;
  basePlanId: string;
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
  features: Partial<Record<CommercialFeaturesType, boolean>>;
}

export const freeFeatures: CommercialFeaturesType[] = [
  PlatformFeature.ACCOUNT_MANAGEMENT,
  PlatformFeature.USE_EXPENSES,
  PlatformFeature.RECEIVE_EXPENSES,
  PlatformFeature.UPDATES,
  PlatformFeature.VENDORS,
  PlatformFeature.FUNDS_GRANTS_MANAGEMENT,
  PlatformFeature.RECEIVE_FINANCIAL_CONTRIBUTIONS,
] as const;

const basicFeatures: CommercialFeaturesType[] = [
  ...freeFeatures,
  PlatformFeature.TRANSFERWISE,
  PlatformFeature.PAYPAL_PAYOUTS,
  PlatformFeature.CHART_OF_ACCOUNTS,
  PlatformFeature.EXPENSE_SECURITY_CHECKS,
  PlatformFeature.EXPECTED_FUNDS,
  PlatformFeature.CHARGE_HOSTING_FEES,
  PlatformFeature.RESTRICTED_FUNDS,
] as const;

const proFeatures: CommercialFeaturesType[] = [
  ...basicFeatures,
  PlatformFeature.AGREEMENTS,
  PlatformFeature.TAX_FORMS,
  PlatformFeature.OFF_PLATFORM_TRANSACTIONS,
] as const;

const featuresForStarter = Object.fromEntries(
  CommercialFeatures.map(feature => [feature, freeFeatures.includes(feature)]),
);

const featuresForBasic = Object.fromEntries(
  CommercialFeatures.map(feature => [feature, basicFeatures.includes(feature)]),
);

const featuresForPro = Object.fromEntries(CommercialFeatures.map(feature => [feature, proFeatures.includes(feature)]));

export const PlatformSubscriptionTiers: Omit<PlatformSubscriptionPlan, 'basePlanId'>[] = [
  // Free
  {
    id: 'discover-1',
    title: 'Discover 1',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 0,
      includedCollectives: 1,
      pricePerAdditionalCollective: 1000,
      includedExpensesPerMonth: 10,
      pricePerAdditionalExpense: 100,
    },
    features: featuresForStarter,
  },
  {
    id: 'discover-3',
    title: 'Discover 3',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 2000,
      includedCollectives: 3,
      pricePerAdditionalCollective: 1000,
      includedExpensesPerMonth: 30,
      pricePerAdditionalExpense: 100,
    },
    features: featuresForStarter,
  },
  {
    id: 'discover-5',
    title: 'Discover 5',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 4000,
      includedCollectives: 5,
      pricePerAdditionalCollective: 1000,
      includedExpensesPerMonth: 50,
      pricePerAdditionalExpense: 100,
    },
    features: featuresForStarter,
  },
  {
    id: 'discover-10',
    title: 'Discover 10',
    type: PlatformSubscriptionTierTypes.FREE,
    pricing: {
      pricePerMonth: 9000,
      includedCollectives: 10,
      pricePerAdditionalCollective: 1000,
      includedExpensesPerMonth: 100,
      pricePerAdditionalExpense: 100,
    },
    features: featuresForStarter,
  },
  // Basic
  {
    id: 'basic-5',
    title: 'Basic 5',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 5000,
      includedCollectives: 5,
      pricePerAdditionalCollective: 1500,
      includedExpensesPerMonth: 50,
      pricePerAdditionalExpense: 150,
    },
    features: featuresForBasic,
  },
  {
    id: 'basic-10',
    title: 'Basic 10',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 13000,
      includedCollectives: 10,
      pricePerAdditionalCollective: 1500,
      includedExpensesPerMonth: 100,
      pricePerAdditionalExpense: 150,
    },
    features: featuresForBasic,
  },
  {
    id: 'basic-20',
    title: 'Basic 20',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 27000,
      includedCollectives: 20,
      pricePerAdditionalCollective: 1500,
      includedExpensesPerMonth: 200,
      pricePerAdditionalExpense: 150,
    },
    features: featuresForBasic,
  },
  {
    id: 'basic-50',
    title: 'Basic 50',
    type: PlatformSubscriptionTierTypes.BASIC,
    pricing: {
      pricePerMonth: 65000,
      includedCollectives: 50,
      pricePerAdditionalCollective: 1500,
      includedExpensesPerMonth: 500,
      pricePerAdditionalExpense: 150,
    },
    features: featuresForBasic,
  },
  // Pro
  {
    id: 'pro-20',
    title: 'Pro 20',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 35000,
      includedCollectives: 20,
      pricePerAdditionalCollective: 2000,
      includedExpensesPerMonth: 200,
      pricePerAdditionalExpense: 200,
    },
    features: featuresForPro,
  },
  {
    id: 'pro-50',
    title: 'Pro 50',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 90000,
      includedCollectives: 50,
      pricePerAdditionalCollective: 2000,
      includedExpensesPerMonth: 500,
      pricePerAdditionalExpense: 200,
    },
    features: featuresForPro,
  },
  {
    id: 'pro-100',
    title: 'Pro 100',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 180000,
      includedCollectives: 100,
      pricePerAdditionalCollective: 2000,
      includedExpensesPerMonth: 1000,
      pricePerAdditionalExpense: 200,
    },
    features: featuresForPro,
  },
  {
    id: 'pro-200',
    title: 'Pro 200',
    type: PlatformSubscriptionTierTypes.PRO,
    pricing: {
      pricePerMonth: 350000,
      includedCollectives: 200,
      pricePerAdditionalCollective: 2000,
      includedExpensesPerMonth: 2000,
      pricePerAdditionalExpense: 200,
    },
    features: featuresForPro,
  },
];

export default legacyPlans;
