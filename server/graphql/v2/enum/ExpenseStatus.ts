import { GraphQLEnumType } from 'graphql';

import expenseStatus from '../../../constants/expense-status';

const GraphQLExpenseStatus = new GraphQLEnumType({
  name: 'ExpenseStatus',
  values: Object.values(expenseStatus).reduce((values, key) => {
    return { ...values, [key]: { value: expenseStatus[key] } };
  }, {}),
});

export default GraphQLExpenseStatus;
