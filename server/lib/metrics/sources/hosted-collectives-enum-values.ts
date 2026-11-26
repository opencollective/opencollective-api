import type { EnumValueDef } from '../internal/types';

export const CONTRIBUTION_FREQUENCY_VALUES: EnumValueDef[] = [
  { value: 'ONE_TIME', description: 'One-time contribution (no recurring order).' },
  { value: 'RECURRING', description: 'Recurring contribution (the order has a monthly/yearly interval).' },
  { value: 'ADDED_FUNDS', description: 'Funds added by the host.' },
  { value: 'OTHER', description: 'Everything else.' },
];

export const AMOUNT_BAND_VALUES: EnumValueDef[] = [
  { value: 'GT_0_LTE_5', description: 'Up to and including 5.' },
  { value: 'GT_5_LTE_10', description: 'Over 5, up to and including 10.' },
  { value: 'GT_10_LTE_25', description: 'Over 10, up to and including 25.' },
  { value: 'GT_25_LTE_50', description: 'Over 25, up to and including 50.' },
  { value: 'GT_50_LTE_75', description: 'Over 50, up to and including 75.' },
  { value: 'GT_75_LTE_100', description: 'Over 75, up to and including 100.' },
  { value: 'GT_100_LTE_150', description: 'Over 100, up to and including 150.' },
  { value: 'GT_150_LTE_200', description: 'Over 150, up to and including 200.' },
  { value: 'GT_200_LTE_250', description: 'Over 200, up to and including 250.' },
  { value: 'GT_250_LTE_500', description: 'Over 250, up to and including 500.' },
  { value: 'GT_500_LTE_1000', description: 'Over 500, up to and including 1,000.' },
  { value: 'GT_1000_LTE_2000', description: 'Over 1,000, up to and including 2,000.' },
  { value: 'GT_2000_LTE_5000', description: 'Over 2,000, up to and including 5,000.' },
  { value: 'GT_5000_LTE_10000', description: 'Over 5,000, up to and including 10,000.' },
  { value: 'GT_10000_LTE_25000', description: 'Over 10,000, up to and including 25,000.' },
  { value: 'GT_25000_LTE_50000', description: 'Over 25,000, up to and including 50,000.' },
  { value: 'GT_50000', description: 'Over 50,000.' },
];
