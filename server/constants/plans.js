const plans = {
  // Legacy Plans (automatically set for accounts created before 2020)
  'legacy-custom': {
    hostedCollectivesLimit: 99,
    addedFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-large': {
    hostedCollectivesLimit: 24,
    addedFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-medium': {
    hostedCollectivesLimit: 9,
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
    hostedCollectivesLimit: 99,
    addedFundsLimit: null,
    hostDashboard: true,
    slug: 'network-host-plan',
    level: 4,
  },
  large: {
    hostedCollectivesLimit: 24,
    addedFundsLimit: null,
    hostDashboard: true,
    slug: 'large-host-plan',
    level: 3,
  },
  medium: {
    hostedCollectivesLimit: 9,
    addedFundsLimit: null,
    hostDashboard: true,
    slug: 'medium-host-plan',
    level: 2,
  },
  small: {
    hostedCollectivesLimit: 1,
    addedFundsLimit: null,
    hostDashboard: false,
    slug: 'small-host-plan',
    level: 1,
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
