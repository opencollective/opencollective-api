enum POLICIES {
  // When enabled, the author (the user that submitted and not necessarily the benefactor) of an Expense, cannot Approve the same expense.
  EXPENSE_AUTHOR_CANNOT_APPROVE = 'EXPENSE_AUTHOR_CANNOT_APPROVE',
  // When enabled, restrict who can apply for fiscal host.
  COLLECTIVE_MINIMUM_ADMINS = 'COLLECTIVE_MINIMUM_ADMINS',
}

export default POLICIES;
