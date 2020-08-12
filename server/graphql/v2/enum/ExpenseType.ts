import { GraphQLEnumType } from 'graphql';

import expenseType from '../../../constants/expense_type';

export const ExpenseType = new GraphQLEnumType({
  name: 'ExpenseType',
  description: 'All supported expense types',
  values: {
    [expenseType.INVOICE]: {
      description: 'Invoice: Charge for your time or get paid in advance.',
    },
    [expenseType.RECEIPT]: {
      description: 'Receipt:  Get paid back for a purchase already made.',
    },
    [expenseType.FUNDING_REQUEST]: {
      description: 'Funding Request: Request funding for a project or initiative.',
    },
    [expenseType.UNCLASSIFIED]: {
      description: 'Unclassified expense',
    },
  },
});
