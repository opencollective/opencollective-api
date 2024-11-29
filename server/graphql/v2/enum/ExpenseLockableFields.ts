import { GraphQLEnumType } from 'graphql';

import { ExpenseLockableFields } from '../../../models/Expense';

const values: Record<ExpenseLockableFields, { description: string }> = {
  [ExpenseLockableFields.AMOUNT]: {
    description: "Locks items' amount and currency, and it also blocks the hability to add new items.",
  },
  [ExpenseLockableFields.PAYEE]: {
    description: 'Locks the payee field, if the user is not on the platform it locks its email.',
  },
  [ExpenseLockableFields.DESCRIPTION]: {
    description: 'Locks the description field.',
  },
  [ExpenseLockableFields.TYPE]: {
    description: 'Locks the type field.',
  },
};

export const GraphQLExpenseLockableFields = new GraphQLEnumType({
  name: 'ExpenseLockableFields',
  description: 'All fields that can be locked on an expense draft',
  values,
});
