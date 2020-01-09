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
  custom: {
    hostedCollectivesLimit: 100,
    addedFundsLimit: null,
    hostDashboard: true,
    slug: 'network-host-plan',
    level: 50,
  },
  large: {
    hostedCollectivesLimit: 25,
    addedFundsLimit: null,
    hostDashboard: true,
    slug: 'large-host-plan',
    level: 40,
  },
  medium: {
    hostedCollectivesLimit: 10,
    addedFundsLimit: null,
    hostDashboard: true,
    slug: 'medium-host-plan',
    level: 30,
  },
  small: {
    hostedCollectivesLimit: 5,
    addedFundsLimit: null,
    hostDashboard: false,
    slug: 'small-host-plan',
    level: 20,
  },
  single: {
    hostedCollectivesLimit: 1,
    addedFundsLimit: null,
    hostDashboard: false,
    slug: 'single-host-plan',
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
