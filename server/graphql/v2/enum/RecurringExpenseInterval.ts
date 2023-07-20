import { GraphQLEnumType } from 'graphql';

import { RecurringExpenseIntervals } from '../../../models/RecurringExpense.js';

export const GraphQLRecurringExpenseInterval = new GraphQLEnumType({
  name: 'RecurringExpenseInterval',
  description: 'All supported intervals for recurring expenses',
  values: Object.values(RecurringExpenseIntervals).reduce((values, value) => ({ ...values, [value]: { value } }), {}),
});
