import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import * as ExpenseLib from '../../common/expenses';

const ExpensePermissions = new GraphQLObjectType({
  name: 'ExpensePermissions',
  description: 'Fields for the user permissions on an expense',
  fields: {
    canEdit: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense',
      async resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canEditExpense(req, expense);
      },
    },
    canDelete: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense',
      resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canDeleteExpense(req, expense);
      },
    },
    canSeeInvoiceInfo: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can the the invoice info for this expense',
      resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canSeeExpenseInvoiceInfo(req, expense);
      },
    },
    canPay: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can trigger the payment for this expense',
      async resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canPayExpense(req, expense);
      },
    },
    canApprove: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can approve this expense',
      async resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canApprove(req, expense);
      },
    },
    canUnapprove: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can unapprove this expense',
      async resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canUnapprove(req, expense);
      },
    },
    canReject: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can reject this expense',
      async resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canReject(req, expense);
      },
    },
    canMarkAsUnpaid: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this expense as unpaid',
      async resolve(expense, _, req): Promise<boolean> {
        return ExpenseLib.canMarkAsUnpaid(req, expense);
      },
    },
  },
});

export default ExpensePermissions;
