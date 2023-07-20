import { compact, mapValues, values } from 'lodash-es';

const plans = {
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
};

export const PLANS_COLLECTIVE_SLUG = 'opencollective';

export const SHARED_REVENUE_PLANS = compact(
  values(mapValues(plans, (v, k) => (v.hostFeeSharePercent > 0 ? k : undefined))),
);

export default plans;
