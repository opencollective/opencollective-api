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
  },
  large: {
    collectiveLimit: 24,
    addFundsLimit: null,
    hostDashboard: true,
  },
  medium: {
    collectiveLimit: 9,
    addFundsLimit: null,
    hostDashboard: true,
  },
  small: {
    collectiveLimit: 1,
    addFundsLimit: null,
    hostDashboard: false,
  },
  // Special plan for everyone without a plan
  default: {
    collectiveLimit: 1,
    addFundsLimit: 100000, // in dollar cents
    hostDashboard: false,
  },
};

export default plans;
