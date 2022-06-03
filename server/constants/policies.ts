const enum POLICIES {
  // When enabled, the author (the user that submitted and not necessarily the benefactor) of an Expense, cannot Approve the same expense.
  EXPENSE_AUTHOR_CANNOT_APPROVE = 'EXPENSE_AUTHOR_CANNOT_APPROVE',
  // When enabled, restrict who can apply for fiscal host.
  COLLECTIVE_MINIMUM_ADMINS = 'COLLECTIVE_MINIMUM_ADMINS',
}

export type Policies = Partial<{
  [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: boolean;
  [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: Partial<{
    numberOfAdmins: number;
  }>;
}>;

// List of Policies that can be seen by anyone
export const PUBLIC_POLICIES = [POLICIES.COLLECTIVE_MINIMUM_ADMINS];

export default POLICIES;
