import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import * as ExpenseLib from '../../common/expenses';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

const ExtendedPermission = new GraphQLObjectType({
  name: 'ExtendedPermission',
  fields: () => ({
    allowed: { type: new GraphQLNonNull(GraphQLBoolean) },
    reason: { type: GraphQLString },
  }),
});

const getPermissionFromEvaluator =
  (fn: ExpenseLib.ExpensePermissionEvaluator) =>
  (expense, _, req: express.Request): Promise<{ allowed: boolean; reason?: string }> => {
    return fn(req, expense, { throw: true })
      .then(allowed => ({ allowed }))
      .catch(error => ({ allowed: false, reason: error?.extensions?.code }));
  };

const ExpensePermissions = new GraphQLObjectType({
  name: 'ExpensePermissions',
  description: 'Fields for the user permissions on an expense',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE),
    },
    canEdit: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canEditExpense(req, expense);
      },
    },
    canEditTags: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description:
        'Tags permissions are a bit different, and can be edited by admins even if the expense has already been paid',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canEditExpenseTags(req, expense);
      },
    },
    canDelete: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense',
      resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canDeleteExpense(req, expense);
      },
    },
    canSeeInvoiceInfo: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can the the invoice info for this expense',
      resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canSeeExpenseInvoiceInfo(req, expense);
      },
    },
    canPay: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can trigger the payment for this expense',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canPayExpense(req, expense);
      },
    },
    canApprove: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can approve this expense',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canApprove(req, expense);
      },
    },
    canUnapprove: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can unapprove this expense',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canUnapprove(req, expense);
      },
    },
    canReject: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can reject this expense',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canReject(req, expense);
      },
    },
    canMarkAsSpam: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this expense as spam',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canMarkAsSpam(req, expense);
      },
    },
    canMarkAsUnpaid: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this expense as unpaid',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canMarkAsUnpaid(req, expense);
      },
    },
    canComment: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can comment and see comments for this expense',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canComment(req, expense);
      },
    },
    canUnschedulePayment: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can unschedule this expense payment',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canUnschedulePayment(req, expense);
      },
    },
    // Extended permissions
    edit: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canEditExpense),
    },
    editTags: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canEditExpenseTags),
    },
    delete: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canDeleteExpense),
    },
    seeInvoiceInfo: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canSeeExpenseInvoiceInfo),
    },
    pay: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canPayExpense),
    },
    approve: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canApprove),
    },
    unapprove: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canUnapprove),
    },
    reject: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canReject),
    },
    markAsSpam: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canMarkAsSpam),
    },
    markAsUnpaid: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canMarkAsUnpaid),
    },
    comment: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canComment),
    },
    unschedulePayment: {
      type: ExtendedPermission,
      resolve: getPermissionFromEvaluator(ExpenseLib.canUnschedulePayment),
    },
  }),
});

export default ExpensePermissions;
