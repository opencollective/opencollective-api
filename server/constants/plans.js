const plans = {
  // Legacy Plans (automatically set for accounts created before 2020)
  'legacy-custom': {
    hostedCollectivesLimit: 100,
    addedFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-large': {
    hostedCollectivesLimit: 25,
    addedFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-medium': {
    hostedCollectivesLimit: 10,
    addedFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-small': {
    hostedCollectivesLimit: 1,
    addedFundsLimit: null,
    hostDashboard: true,
  },
  // Plans (for customers from 2020)
  owned: {
    hostedCollectivesLimit: null,
    addedFundsLimit: null,
    hostDashboard: true,
  },
  // These keys must match OpenCollective's existing Tier slugs and their data
  // should be updated in our Tier database.
  'network-host-plan': {
    hostedCollectivesLimit: 100,
    addedFundsLimit: null,
    hostDashboard: true,
    level: 50,
  },
  'large-host-plan': {
    hostedCollectivesLimit: 25,
    addedFundsLimit: null,
    hostDashboard: true,
    level: 40,
  },
  'medium-host-plan': {
    hostedCollectivesLimit: 10,
    addedFundsLimit: null,
    hostDashboard: true,
    level: 30,
  },
  'small-host-plan': {
    hostedCollectivesLimit: 5,
    addedFundsLimit: null,
    hostDashboard: false,
    level: 20,
  },
  'single-host-plan': {
    hostedCollectivesLimit: 1,
    addedFundsLimit: null,
    hostDashboard: false,
    level: 10,
  },
  // Special plan for everyone without a plan
  default: {
    hostedCollectivesLimit: 1,
    addedFundsLimit: 100000, // in dollar cents
    hostDashboard: false,
  },
};

export const PLANS_COLLECTIVE_SLUG = 'opencollective';

export default plans;
