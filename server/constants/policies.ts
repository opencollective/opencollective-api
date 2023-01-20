import config from 'config';

import { VirtualCardLimitIntervals } from './virtual-cards';

const enum POLICIES {
  // When enabled, the author (the user that submitted and not necessarily the benefactor) of an Expense, cannot Approve the same expense.
  EXPENSE_AUTHOR_CANNOT_APPROVE = 'EXPENSE_AUTHOR_CANNOT_APPROVE',
  // When enabled, restrict who can apply for fiscal host.
  COLLECTIVE_MINIMUM_ADMINS = 'COLLECTIVE_MINIMUM_ADMINS',
  // Specifies the maximum virtual card limit amount per interval
  MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL = 'MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL',
  // When enabled, all admins of the account will have to enable 2FA before they can perform any action.
  REQUIRE_2FA_FOR_ADMINS = 'REQUIRE_2FA_FOR_ADMINS',
}

export type Policies = Partial<{
  [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
    enabled: boolean;
    amountInCents: number;
    appliesToHostedCollectives: boolean;
    appliesToSingleAdminCollectives: boolean;
  };
  [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: Partial<{
    numberOfAdmins: number;
    applies: 'ALL_COLLECTIVES' | 'NEW_COLLECTIVES';
    freeze: boolean;
  }>;
  [POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL]: Partial<{
    [interval in VirtualCardLimitIntervals]: number;
  }>;

  [POLICIES.REQUIRE_2FA_FOR_ADMINS]: boolean;
}>;

export const DEFAULT_POLICIES: { [T in POLICIES]: Policies[T] } = {
  [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
    enabled: false,
    amountInCents: 0,
    appliesToHostedCollectives: false,
    appliesToSingleAdminCollectives: false,
  },
  [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: {
    numberOfAdmins: 0,
    applies: 'NEW_COLLECTIVES',
    freeze: false,
  },
  [POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL]: {
    [VirtualCardLimitIntervals.ALL_TIME]:
      config.virtualCards.maximumLimitForInterval[VirtualCardLimitIntervals.ALL_TIME],
    [VirtualCardLimitIntervals.DAILY]: config.virtualCards.maximumLimitForInterval[VirtualCardLimitIntervals.DAILY],
    [VirtualCardLimitIntervals.MONTHLY]: config.virtualCards.maximumLimitForInterval[VirtualCardLimitIntervals.MONTHLY],
    [VirtualCardLimitIntervals.PER_AUTHORIZATION]:
      config.virtualCards.maximumLimitForInterval[VirtualCardLimitIntervals.PER_AUTHORIZATION],
    [VirtualCardLimitIntervals.WEEKLY]: config.virtualCards.maximumLimitForInterval[VirtualCardLimitIntervals.WEEKLY],
    [VirtualCardLimitIntervals.YEARLY]: config.virtualCards.maximumLimitForInterval[VirtualCardLimitIntervals.YEARLY],
  },
  [POLICIES.REQUIRE_2FA_FOR_ADMINS]: false,
};

// List of Policies that can be seen by anyone
export const PUBLIC_POLICIES = [POLICIES.COLLECTIVE_MINIMUM_ADMINS];

export default POLICIES;
