import { VirtualCardLimitIntervals } from '../constants/virtual-cards';
import type Collective from '../models/Collective';

/** All the spending limit intervals that can be requested for a virtual card. */
const ALL_VIRTUAL_CARD_LIMIT_INTERVALS: VirtualCardLimitIntervals[] = Object.values(VirtualCardLimitIntervals);

/**
 * Returns the spending limit intervals that collectives can pick when requesting a virtual card from this host.
 * All intervals are allowed by default: `settings.virtualcards.allowedSpendingLimitIntervals` only disables
 * the intervals that are explicitly set to `false`.
 */
export const getAllowedSpendingLimitIntervals = (host: Collective | null | undefined): VirtualCardLimitIntervals[] => {
  const allowedSpendingLimitIntervals = host?.settings?.virtualcards?.allowedSpendingLimitIntervals;
  return ALL_VIRTUAL_CARD_LIMIT_INTERVALS.filter(interval => allowedSpendingLimitIntervals?.[interval] !== false);
};
