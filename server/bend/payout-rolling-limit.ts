/**
 * Typed access to the rolling limit above which a payout requires a fresh 2FA token.
 *
 * The rule itself is written in Bend (`./payout-rolling-limit.bend`), where it is proven to obey the laws in
 * `/LAWS.bend`, and compiled to `./generated/payout-rolling-limit.mjs`. This file only translates values at the
 * boundary: it must never decide anything. See `docs/bend-laws.md`.
 */

import generatedKernel from './generated/payout-rolling-limit.mjs';
import { callBend, MAX_BEND_NAT, toBendBool, toBendNat } from './interop';

/** All amounts are in cents of the host currency */
type PayoutRollingLimitFacts = {
  /** The host's rolling limit */
  limit: number;
  /** Total paid without a token since the last one; `null` when nothing is remembered (first payout, expired) */
  paidSinceToken: number | null;
  /** Amount of the payout being made */
  amount: number;
};

export type PayoutRollingLimitDecision = {
  /** A fresh 2FA token is required for this payout */
  askForToken: boolean;
  /** What to remember for the next payout */
  paidSinceToken: number;
};

const kernel = generatedKernel as {
  decide: (limit: number, paid: unknown, amount: number) => { ask_for_token: boolean; paid_since_token: number };
};

export const decidePayoutRollingLimit = (facts: PayoutRollingLimitFacts): PayoutRollingLimitDecision => {
  const paid =
    facts.paidSinceToken === null
      ? { $: 'None' }
      : { $: 'Some', value: toBendNat(facts.paidSinceToken, 'paidSinceToken') };

  const decision = callBend(() =>
    kernel.decide(toBendNat(facts.limit, 'limit'), paid, toBendNat(facts.amount, 'amount')),
  );

  return {
    askForToken: toBendBool(decision.ask_for_token, 'ask_for_token'),
    paidSinceToken: toBendNat(decision.paid_since_token, 'paid_since_token'),
  };
};

/**
 * Reads the rolling limit from the host settings, which do not validate it. The comparison is between whole numbers
 * of cents, so a fractional limit is rounded down, which changes no decision. A limit that is not a number becomes
 * 0: every payout then asks for a token.
 */
export const parsePayoutRollingLimit = (value: unknown): number => {
  const limit = Number(value);
  if (Number.isNaN(limit)) {
    return 0;
  }

  return Math.min(MAX_BEND_NAT, Math.max(0, Math.floor(limit)));
};

/**
 * Reads the total remembered in the cache. Nothing in the cache means nothing is remembered. So does a value that
 * cannot be a total (negative, fractional, too large): the payout then asks for a token, which restarts the count.
 */
export const parsePaidSinceToken = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const total = Number(value) || 0;
  return Number.isInteger(total) && total >= 0 && total <= MAX_BEND_NAT ? total : null;
};
