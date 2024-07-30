import config from 'config';

import { VirtualCardLimitIntervals } from './virtual-cards';

enum POLICIES {
  // When enabled, the author (the user that submitted and not necessarily the benefactor) of an Expense, cannot Approve the same expense.
  EXPENSE_AUTHOR_CANNOT_APPROVE = 'EXPENSE_AUTHOR_CANNOT_APPROVE',
  // When enabled, restrict who can apply for fiscal host.
  COLLECTIVE_MINIMUM_ADMINS = 'COLLECTIVE_MINIMUM_ADMINS',
  // Specifies the maximum virtual card limit amount per interval
  MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL = 'MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL',
  // When enabled, all admins of the account will have to enable 2FA before they can perform any action.
  REQUIRE_2FA_FOR_ADMINS = 'REQUIRE_2FA_FOR_ADMINS',
  // When enabled, admins of the collective are allowed to refund expenses
  COLLECTIVE_ADMINS_CAN_REFUND = 'COLLECTIVE_ADMINS_CAN_REFUND',
  // Whether we expect expense submitters and collective admins to take part in the expense categorization process (for accounting)
  EXPENSE_CATEGORIZATION = 'EXPENSE_CATEGORIZATION',
  // When enabled, users can also use Vendors when submitting expenses.
  EXPENSE_PUBLIC_VENDORS = 'EXPENSE_PUBLIC_VENDORS',
  // When enabled, admins of the collective are allowed to see the payout methods of expenses
  COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS = 'COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS',
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
  [POLICIES.COLLECTIVE_ADMINS_CAN_REFUND]: boolean;
  [POLICIES.EXPENSE_CATEGORIZATION]: {
    requiredForExpenseSubmitters: boolean;
    requiredForCollectiveAdmins: boolean;
  };
  [POLICIES.EXPENSE_PUBLIC_VENDORS]: boolean;
  [POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS]: boolean;
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
  [POLICIES.COLLECTIVE_ADMINS_CAN_REFUND]: true,
  [POLICIES.EXPENSE_CATEGORIZATION]: {
    requiredForExpenseSubmitters: false,
    requiredForCollectiveAdmins: false,
  },
  [POLICIES.EXPENSE_PUBLIC_VENDORS]: false,
  [POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS]: false,
};

export default POLICIES;
