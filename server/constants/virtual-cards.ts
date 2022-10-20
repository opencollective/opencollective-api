export enum VirtualCardLimitIntervals {
  PER_AUTHORIZATION = 'PER_AUTHORIZATION',
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
  ALL_TIME = 'ALL_TIME',
}

export const VirtualCardMaximumLimitForInterval: { [interval in VirtualCardLimitIntervals]: number } = {
  [VirtualCardLimitIntervals.PER_AUTHORIZATION]: 5000,
  [VirtualCardLimitIntervals.DAILY]: 5000,
  [VirtualCardLimitIntervals.WEEKLY]: 5000,
  [VirtualCardLimitIntervals.MONTHLY]: 5000,
  [VirtualCardLimitIntervals.YEARLY]: 5000,
  [VirtualCardLimitIntervals.ALL_TIME]: 5000,
};
