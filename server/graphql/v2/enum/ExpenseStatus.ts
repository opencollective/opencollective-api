import { GraphQLEnumType } from 'graphql';
import expenseStatus from '../../../constants/expense_status';

const ExpenseStatus = new GraphQLEnumType({
  name: 'ExpenseStatus',
  values: Object.values(expenseStatus).reduce((values, key) => {
    return { ...values, [key]: { value: expenseStatus[key] } };
  }, {}),
});

export default ExpenseStatus;
