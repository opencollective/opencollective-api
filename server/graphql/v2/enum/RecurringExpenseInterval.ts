import { GraphQLEnumType } from 'graphql';

import { RecurringExpenseIntervals } from '../../../models/RecurringExpense';

export const RecurringExpenseInterval = new GraphQLEnumType({
  name: 'RecurringExpenseInterval',
  description: 'All supported intervals for recurring expenses',
  values: Object.values(RecurringExpenseIntervals).reduce((values, value) => ({ ...values, [value]: { value } }), {}),
});
