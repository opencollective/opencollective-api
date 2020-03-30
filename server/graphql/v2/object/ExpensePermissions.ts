import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import * as ExpensePermissionsLib from '../../common/expenses';

const ExpensePermissions = new GraphQLObjectType({
  name: 'ExpensePermissions',
  description: 'Fields for an expense attachment',
  fields: {
    canEdit: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense',
      resolve(expense, _, req): boolean {
        return ExpensePermissionsLib.canEditExpense(req.remoteUser, expense);
      },
    },
    canDelete: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense',
      resolve(expense, _, req): boolean {
        return ExpensePermissionsLib.canDeleteExpense(req.remoteUser, expense);
      },
    },
    canSeeInvoiceInfo: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can the the invoice info for this expense',
      resolve(expense, _, req): Promise<boolean> {
        return ExpensePermissionsLib.canSeeExpenseInvoiceInfo(req, expense);
      },
    },
  },
});

export default ExpensePermissions;
