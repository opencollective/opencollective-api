import { GraphQLEnumType } from 'graphql';

import expenseStatus from '../../../constants/expense_status';

const ExpenseStatusFilter = new GraphQLEnumType({
  name: 'ExpenseStatusFilter',
  description:
    'Describes the values allowed to filter expenses, namely all the expense statuses and the special "READY_TO_PAY" value.',
  values: {
    // All expenses status are valid filters
    ...Object.values(expenseStatus).reduce((values, key) => {
      return { ...values, [key]: { value: expenseStatus[key] } };
    }, {}),
    // Special conditions and pseud-status selectors
    READY_TO_PAY: {
      value: 'READY_TO_PAY',
      description:
        'Only expenses that are ready to be paid (must be approved, have the sufficiant balance and have the tax forms completed)',
    },
    ON_HOLD: {
      value: 'ON_HOLD',
      description: 'Only expenses that are on hold',
    },
  },
});

export default ExpenseStatusFilter;
