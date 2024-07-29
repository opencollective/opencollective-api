import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import * as ExpenseLib from '../../common/expenses';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLPermission, parsePermissionFromEvaluator } from './Permission';

const GraphQLExpensePermissions = new GraphQLObjectType({
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
    canEditAccountingCategory: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense accounting category',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canEditExpenseAccountingCategory(req, expense);
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
    canMarkAsIncomplete: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can mark this expense as incomplete',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canMarkAsIncomplete(req, expense);
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
    canVerifyDraftExpense: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can verify this draft expense',
      async resolve(expense, _, req: express.Request): Promise<boolean> {
        return ExpenseLib.canVerifyDraftExpense(req, expense);
      },
    },
    canUsePrivateNote: {
      type: new GraphQLNonNull(GraphQLBoolean),
      resolve: (expense, _, req) => ExpenseLib.canUsePrivateNotes(req, expense),
    },
    canHold: {
      type: new GraphQLNonNull(GraphQLBoolean),
      resolve: (expense, _, req) => ExpenseLib.canPutOnHold(req, expense),
    },
    canRelease: {
      type: new GraphQLNonNull(GraphQLBoolean),
      resolve: (expense, _, req) => ExpenseLib.canReleaseHold(req, expense),
    },
    canDownloadTaxForm: {
      type: new GraphQLNonNull(GraphQLBoolean),
      resolve: (expense, _, req) => ExpenseLib.canDownloadTaxForm(req, expense),
    },
    canSeePayoutMethodPrivateDetails: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can see the private details of the payout method of this expense',
      resolve: (expense, _, req: express.Request) => ExpenseLib.canSeeExpensePayoutMethodPrivateDetails(req, expense),
    },
    // Extended permissions
    edit: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canEditExpense),
    },
    editAccountingCategory: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the expense accounting category',
      resolve: parsePermissionFromEvaluator(ExpenseLib.canEditExpenseAccountingCategory),
    },
    editTags: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canEditExpenseTags),
    },
    delete: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canDeleteExpense),
    },
    seeInvoiceInfo: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canSeeExpenseInvoiceInfo),
    },
    pay: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canPayExpense),
    },
    approve: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canApprove),
    },
    unapprove: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canUnapprove),
    },
    reject: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canReject),
    },
    markAsSpam: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canMarkAsSpam),
    },
    markAsUnpaid: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canMarkAsUnpaid),
    },
    comment: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canComment),
    },
    usePrivateNote: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canUsePrivateNotes),
    },
    unschedulePayment: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canUnschedulePayment),
    },
    verifyDraftExpense: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canVerifyDraftExpense),
    },
    hold: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canPutOnHold),
    },
    release: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canReleaseHold),
    },
    downloadTaxForm: {
      type: new GraphQLNonNull(GraphQLPermission),
      resolve: parsePermissionFromEvaluator(ExpenseLib.canDownloadTaxForm),
    },
  }),
});

export default GraphQLExpensePermissions;
