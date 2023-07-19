import { GraphQLEnumType } from 'graphql';
import { invert } from 'lodash-es';

import INTERVALS from '../../../constants/intervals.js';

export enum TierFrequencyKey {
  MONTHLY = 'MONTHLY',
  YEARLY = 'YEARLY',
  ONETIME = 'ONETIME',
  FLEXIBLE = 'FLEXIBLE',
}

export const GraphQLTierFrequency = new GraphQLEnumType({
  name: 'TierFrequency',
  values: Object.keys(TierFrequencyKey).reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});

const TIER_FREQUENCY_TO_INTERVAL: Record<TierFrequencyKey, INTERVALS | null> = {
  MONTHLY: INTERVALS.MONTH,
  YEARLY: INTERVALS.YEAR,
  FLEXIBLE: INTERVALS.FLEXIBLE,
  ONETIME: null,
};

const TIER_INTERVAL_TO_FREQUENCY = <Record<INTERVALS | null, TierFrequencyKey>>invert(TIER_FREQUENCY_TO_INTERVAL);

/**
 * From a tier frequency provided as `TierFrequency` GQLV2 enum, returns an interval
 * as we use it in the DB (ie. MONTHLY => month)
 */
export const getIntervalFromTierFrequency = (input: TierFrequencyKey): INTERVALS | null => {
  return TIER_FREQUENCY_TO_INTERVAL[input];
};

/**
 * From a tier interval from the DB, returns a `TierFrequency` GQLV2 enum (ie. month => MONTHLY)
 */
export const getTierFrequencyFromInterval = (input: INTERVALS): TierFrequencyKey => {
  return TIER_INTERVAL_TO_FREQUENCY[input];
};
