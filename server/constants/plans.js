const plans = {
  // Legacy Plans (automatically set for accounts created before 2020)
  'legacy-custom': {
    collectiveLimit: 99,
    addFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-large': {
    collectiveLimit: 24,
    addFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-medium': {
    collectiveLimit: 9,
    addFundsLimit: null,
    hostDashboard: true,
  },
  'legacy-small': {
    collectiveLimit: 1,
    addFundsLimit: null,
    hostDashboard: true,
  },
  // Plans (for customers from 2020)
  owned: {
    collectiveLimit: null,
    addFundsLimit: null,
    hostDashboard: true,
  },
  custom: {
    collectiveLimit: 99,
    addFundsLimit: null,
    hostDashboard: true,
    slug: 'network-host-plan',
    tier: 4,
  },
  large: {
    collectiveLimit: 24,
    addFundsLimit: null,
    hostDashboard: true,
    slug: 'large-host-plan',
    tier: 3,
  },
  medium: {
    collectiveLimit: 9,
    addFundsLimit: null,
    hostDashboard: true,
    slug: 'medium-host-plan',
    tier: 2,
  },
  small: {
    collectiveLimit: 1,
    addFundsLimit: null,
    hostDashboard: false,
    slug: 'small-host-plan',
    tier: 1,
  },
  // Special plan for everyone without a plan
  default: {
    collectiveLimit: 1,
    addFundsLimit: 100000, // in dollar cents
    hostDashboard: false,
  },
};

export const PLANS_COLLECTIVE_SLUG = 'opencollective';

export default plans;
