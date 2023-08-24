import config from 'config';
import express from 'express';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { pick, size } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../../../constants/activities';
import { CollectiveType as collectiveTypes } from '../../../constants/collectives';
import expenseStatus from '../../../constants/expense_status';
import logger from '../../../lib/logger';
import RateLimit from '../../../lib/rate-limit';
import { reportErrorToSentry } from '../../../lib/sentry';
import twoFactorAuthLib from '../../../lib/two-factor-authentication/lib';
import models from '../../../models';
import { CommentType } from '../../../models/Comment';
import ExpenseModel from '../../../models/Expense';
import { createComment } from '../../common/comment';
import {
  approveExpense,
  canDeleteExpense,
  canVerifyDraftExpense,
  computeTotalAmountForExpense,
  createExpense,
  editExpense,
  editExpenseDraft,
  holdExpense,
  markExpenseAsIncomplete,
  markExpenseAsSpam,
  markExpenseAsUnpaid,
  payExpense,
  rejectExpense,
  releaseExpense,
  requestExpenseReApproval,
  scheduleExpenseForPayment,
  unapproveExpense,
  unscheduleExpensePayment,
} from '../../common/expenses';
import { checkRemoteUserCanUseExpenses, enforceScope } from '../../common/scope-check';
import { NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';
import { GraphQLExpenseProcessAction } from '../enum/ExpenseProcessAction';
import { GraphQLFeesPayer } from '../enum/FeesPayer';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLExpenseCreateInput } from '../input/ExpenseCreateInput';
import { GraphQLExpenseInviteDraftInput } from '../input/ExpenseInviteDraftInput';
import {
  fetchExpenseWithReference,
  getDatabaseIdFromExpenseReference,
  GraphQLExpenseReferenceInput,
} from '../input/ExpenseReferenceInput';
import { GraphQLExpenseUpdateInput } from '../input/ExpenseUpdateInput';
import { GraphQLRecurringExpenseInput } from '../input/RecurringExpenseInput';
import { GraphQLExpense } from '../object/Expense';

const expenseMutations = {
  createExpense: {
    type: new GraphQLNonNull(GraphQLExpense),
    description: 'Submit an expense to a collective. Scope: "expenses".',
    args: {
      expense: {
        type: new GraphQLNonNull(GraphQLExpenseCreateInput),
        description: 'Expense data',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the expense will be created',
      },
      recurring: {
        type: GraphQLRecurringExpenseInput,
        description: 'Recurring Expense information',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExpenseModel> {
      checkRemoteUserCanUseExpenses(req);

      const payoutMethod = args.expense.payoutMethod;
      if (payoutMethod.id) {
        payoutMethod.id = idDecode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
      }

      const fromCollective = await fetchAccountWithReference(args.expense.payee, { throwIfMissing: true });
      await twoFactorAuthLib.enforceForAccount(req, fromCollective, { onlyAskOnLogin: true });

      // Right now this endpoint uses the old mutation by adapting the data for it. Once we get rid
      // of the `createExpense` endpoint in V1, the actual code to create the expense should be moved
      // here and cleaned.
      const expense = await createExpense(req.remoteUser, {
        ...pick(args.expense, [
          'description',
          'longDescription',
          'tags',
          'type',
          'privateMessage',
          'attachedFiles',
          'invoiceInfo',
          'payeeLocation',
          'currency',
          'items',
          'tax',
          'customData',
        ]),
        payoutMethod,
        collective: await fetchAccountWithReference(args.account, req),
        fromCollective,
      });

      if (args.recurring) {
        await models.RecurringExpense.createFromExpense(expense, args.recurring.interval, args.recurring.endsAt);
      }

      return expense;
    },
  },
  editExpense: {
    type: new GraphQLNonNull(GraphQLExpense),
    description: 'To update an existing expense',
    args: {
      expense: {
        type: new GraphQLNonNull(GraphQLExpenseUpdateInput),
        description: 'Expense data',
      },
      draftKey: {
        type: GraphQLString,
        description: 'Expense draft key if invited to submit expense. Scope: "expenses".',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExpenseModel> {
      // NOTE(oauth-scope): Ok for non-authenticated users, we only check scope
      enforceScope(req, 'expenses');

      // Support deprecated `attachments` field
      const items = args.expense.items || args.expense.attachments;
      const expense = args.expense;
      const payeeExists = expense.payee?.id || expense.payee?.legacyId;

      const expenseData = {
        id: idDecode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        description: expense.description,
        tags: expense.tags,
        type: expense.type,
        currency: expense.currency,
        payeeLocation: expense.payeeLocation,
        privateMessage: expense.privateMessage,
        invoiceInfo: expense.invoiceInfo,
        customData: expense.customData,
        payoutMethod: expense.payoutMethod && {
          id: expense.payoutMethod.id && idDecode(expense.payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
          data: expense.payoutMethod.data,
          name: expense.payoutMethod.name,
          isSaved: expense.payoutMethod.isSaved,
          type: expense.payoutMethod.type,
        },
        items: items?.map(item => ({
          id: item.id && idDecode(item.id, IDENTIFIER_TYPES.EXPENSE_ITEM),
          url: item.url,
          amount: item.amount,
          incurredAt: item.incurredAt,
          description: item.description,
        })),
        tax: expense.tax,
        attachedFiles: expense.attachedFiles?.map(attachedFile => ({
          id: attachedFile.id && idDecode(attachedFile.id, IDENTIFIER_TYPES.EXPENSE_ITEM),
          url: attachedFile.url,
        })),
        fromCollective: payeeExists && (await fetchAccountWithReference(expense.payee, { throwIfMissing: true })),
      };

      if (args.draftKey) {
        return editExpenseDraft(req, expenseData, { args });
      }

      return editExpense(req, expenseData);
    },
  },
  deleteExpense: {
    type: new GraphQLNonNull(GraphQLExpense),
    description: `Delete an expense. Only work if the expense is rejected - please check permissions.canDelete. Scope: "expenses".`,
    args: {
      expense: {
        type: new GraphQLNonNull(GraphQLExpenseReferenceInput),
        description: 'Reference of the expense to delete',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExpenseModel> {
      checkRemoteUserCanUseExpenses(req);

      const expenseId = getDatabaseIdFromExpenseReference(args.expense);
      const expense = await models.Expense.findByPk(expenseId, {
        // Need to load the collective because canDeleteExpense checks expense.collective.HostCollectiveId
        include: [
          { model: models.Collective, as: 'collective', include: [{ association: 'host' }] },
          { model: models.Collective, as: 'fromCollective' },
        ],
      });

      if (!expense) {
        throw new NotFound('Expense not found');
      } else if (!(await canDeleteExpense(req, expense))) {
        throw new Unauthorized(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      }

      // Check if 2FA is enforced on any of the account remote user is admin of
      const accountsFor2FA = [expense.fromCollective, expense.collective, expense.collective.host].filter(Boolean);
      await twoFactorAuthLib.enforceForAccountsUserIsAdminOf(req, accountsFor2FA);

      // Cancel recurring expense
      const recurringExpense = await expense.getRecurringExpense();
      if (recurringExpense) {
        await recurringExpense.destroy();
      }

      await expense.destroy();
      return expense;
    },
  },
  processExpense: {
    type: new GraphQLNonNull(GraphQLExpense),
    description: 'Process the expense with the given action. Scope: "expenses".',
    args: {
      expense: {
        type: new GraphQLNonNull(GraphQLExpenseReferenceInput),
        description: 'Reference of the expense to process',
      },
      action: {
        type: new GraphQLNonNull(GraphQLExpenseProcessAction),
        description: 'The action to trigger',
      },
      message: {
        type: GraphQLString,
        description: 'Message to be attached to the action activity.',
      },
      paymentParams: {
        description: 'If action is related to a payment, this object used for the payment parameters',
        type: new GraphQLInputObjectType({
          name: 'ProcessExpensePaymentParams',
          description: 'Parameters for paying an expense',
          fields: () => ({
            paymentProcessorFeeInHostCurrency: {
              type: GraphQLInt,
              description: 'The fee charged by payment processor in host currency',
            },
            totalAmountPaidInHostCurrency: {
              type: GraphQLInt,
              description: 'The total amount paid in host currency',
            },
            shouldRefundPaymentProcessorFee: {
              type: GraphQLBoolean,
              description: 'Whether the payment processor fees should be refunded when triggering MARK_AS_UNPAID',
            },
            markAsUnPaidStatus: {
              type: new GraphQLEnumType({
                name: 'MarkAsUnPaidExpenseStatus',
                values: {
                  [expenseStatus.APPROVED]: { value: expenseStatus.APPROVED },
                  [expenseStatus.INCOMPLETE]: { value: expenseStatus.INCOMPLETE },
                  [expenseStatus.ERROR]: { value: expenseStatus.ERROR },
                },
              }),
              description: 'New expense status when triggering MARK_AS_UNPAID',
              defaultValue: expenseStatus.APPROVED,
            },
            forceManual: {
              type: GraphQLBoolean,
              description: 'Bypass automatic integrations (ie. PayPal, Transferwise) to process the expense manually',
            },
            feesPayer: {
              type: GraphQLFeesPayer,
              description: 'Who is responsible for paying any due fees.',
              defaultValue: 'COLLECTIVE',
            },
          }),
        }),
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExpenseModel> {
      checkRemoteUserCanUseExpenses(req);

      let expense = await fetchExpenseWithReference(args.expense, { loaders: req.loaders, throwIfMissing: true });
      const collective = await expense.getCollective();
      const host = await collective.getHostCollective({ loaders: req.loaders });

      // Enforce 2FA for processing expenses, except for `PAY` action which handles it internally (with rolling limit)
      if (!['PAY', 'SCHEDULE_FOR_PAYMENT'].includes(args.action)) {
        const accountsFor2FA = [host, collective].filter(Boolean);
        await twoFactorAuthLib.enforceForAccountsUserIsAdminOf(req, accountsFor2FA);
      }

      switch (args.action) {
        case 'APPROVE':
          expense = await approveExpense(req, expense);
          break;
        case 'UNAPPROVE':
          expense = await unapproveExpense(req, expense);
          break;
        case 'REQUEST_RE_APPROVAL':
          expense = await requestExpenseReApproval(req, expense);
          break;
        case 'MARK_AS_INCOMPLETE':
          expense = await markExpenseAsIncomplete(req, expense);
          break;
        case 'REJECT':
          expense = await rejectExpense(req, expense);
          break;
        case 'MARK_AS_SPAM':
          expense = await markExpenseAsSpam(req, expense);
          break;
        case 'MARK_AS_UNPAID':
          expense = await markExpenseAsUnpaid(
            req,
            expense.id,
            args.paymentParams?.shouldRefundPaymentProcessorFee || args.paymentParams?.paymentProcessorFee,
            args.paymentParams?.markAsUnPaidStatus,
          );
          break;
        case 'SCHEDULE_FOR_PAYMENT':
          expense = await scheduleExpenseForPayment(req, expense, {
            feesPayer: args.paymentParams?.feesPayer,
          });
          break;
        case 'UNSCHEDULE_PAYMENT':
          expense = await unscheduleExpensePayment(req, expense);
          break;
        case 'PAY':
          expense = await payExpense(req, {
            id: expense.id,
            forceManual: args.paymentParams?.forceManual,
            feesPayer: args.paymentParams?.feesPayer,
            paymentProcessorFeeInHostCurrency: args.paymentParams?.paymentProcessorFeeInHostCurrency,
            totalAmountPaidInHostCurrency: args.paymentParams?.totalAmountPaidInHostCurrency,
          });
          break;
        case 'HOLD':
          expense = await holdExpense(req, expense);
          break;
        case 'RELEASE':
          expense = await releaseExpense(req, expense);
          break;
      }

      if (args.message) {
        await createComment(
          {
            ExpenseId: expense.id,
            html: args.message,
            type: ['HOLD', 'RELEASE'].includes(args.action) ? CommentType.PRIVATE_NOTE : CommentType.COMMENT,
          },
          req,
          { triggerStatusChange: false },
        );
      }

      return expense;
    },
  },
  draftExpenseAndInviteUser: {
    type: new GraphQLNonNull(GraphQLExpense),
    description: 'Persist an Expense as a draft and invite someone to edit and submit it. Scope: "expenses".',
    args: {
      expense: {
        type: new GraphQLNonNull(GraphQLExpenseInviteDraftInput),
        description: 'Expense data',
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account where the expense will be created',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExpenseModel> {
      checkRemoteUserCanUseExpenses(req);

      const remoteUser = req.remoteUser;
      const expenseData = args.expense;

      const rateLimit = new RateLimit(`draft_expense_${remoteUser.id}`, 1, 10, true);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      if (size(expenseData.attachedFiles) > 15) {
        throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
      }

      const collective = await fetchAccountWithReference(args.account, req);
      if (!collective) {
        throw new ValidationFailed('Collective not found');
      }

      const isAllowedType = [
        collectiveTypes.COLLECTIVE,
        collectiveTypes.EVENT,
        collectiveTypes.FUND,
        collectiveTypes.PROJECT,
      ].includes(collective.type);
      const isActiveHost = collective.type === collectiveTypes.ORGANIZATION && collective.isActive;
      if (!isAllowedType && !isActiveHost) {
        throw new ValidationFailed(
          'Expenses can only be submitted to Collectives, Events, Funds, Projects and active Hosts.',
        );
      }

      const draftKey = process.env.OC_ENV === 'e2e' || process.env.OC_ENV === 'ci' ? 'draft-key' : uuid();
      const expenseFields = ['description', 'longDescription', 'tags', 'type', 'privateMessage', 'invoiceInfo'];

      const fromCollective = await remoteUser.getCollective({ loaders: req.loaders });
      const payeeLegacyId = expenseData.payee?.legacyId || expenseData.payee?.id;
      const payee = payeeLegacyId
        ? (await fetchAccountWithReference({ legacyId: payeeLegacyId }, { throwIfMissing: true }))?.minimal
        : expenseData.payee;
      const expense = await models.Expense.create({
        ...pick(expenseData, expenseFields),
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        lastEditedById: remoteUser.id,
        UserId: remoteUser.id,
        currency: expenseData.currency || collective.currency,
        incurredAt: new Date(),
        amount: computeTotalAmountForExpense(expenseData.items, expenseData.tax),
        data: {
          items: expenseData.items,
          attachedFiles: expenseData.attachedFiles,
          payee,
          invitedByCollectiveId: fromCollective.id,
          draftKey,
          recipientNote: expenseData.recipientNote,
          payoutMethod: expenseData.payoutMethod,
          payeeLocation: expenseData.payeeLocation,
          customData: expenseData.customData,
          taxes: expenseData.tax,
        },
        status: expenseStatus.DRAFT,
      });

      // If the payee is already an user, we redirect the action button in the email to signin first and later redirect to the expense
      const inviteUrl = payee.id
        ? `${config.host.website}/signin?next=/${collective.slug}/expenses/${expense.id}?key=${draftKey}`
        : `${config.host.website}/${collective.slug}/expenses/${expense.id}?key=${draftKey}`;

      expense
        .createActivity(activities.COLLECTIVE_EXPENSE_INVITE_DRAFTED, remoteUser, { ...expense.data, inviteUrl })
        .catch(e => {
          logger.error('An error happened when creating the COLLECTIVE_EXPENSE_INVITE_DRAFTED activity', e);
          reportErrorToSentry(e);
        });

      if (config.env === 'development') {
        logger.info(`Expense Invite Link: ${inviteUrl}`);
      }

      return expense;
    },
  },
  resendDraftExpenseInvite: {
    type: new GraphQLNonNull(GraphQLExpense),
    description: 'To re-send the invitation to complete a draft expense. Scope: "expenses".',
    args: {
      expense: {
        type: new GraphQLNonNull(GraphQLExpenseReferenceInput),
        description: 'Reference of the expense to process',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<ExpenseModel> {
      // NOTE(oauth-scope): Ok for non-authenticated users, we only check scope
      enforceScope(req, 'expenses');

      const expenseId = getDatabaseIdFromExpenseReference(args.expense);

      const rateLimit = new RateLimit(`resend_draft_invite_${expenseId}`, 2, 10);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      const expense = await models.Expense.findByPk(expenseId, {
        include: [{ model: models.Collective, as: 'collective' }],
      });
      if (!expense) {
        throw new NotFound('Expense not found');
      } else if (expense.status !== expenseStatus.DRAFT) {
        throw new Unauthorized('Expense was already submitted.');
      } else if (!(await canVerifyDraftExpense(req, expense))) {
        throw new Unauthorized("You don't have the permission resend a draft for this expense.");
      }

      const draftKey = expense.data.draftKey;
      const inviteUrl = `${config.host.website}/${expense.collective.slug}/expenses/${expense.id}?key=${draftKey}`;
      expense
        .createActivity(activities.COLLECTIVE_EXPENSE_INVITE_DRAFTED, req.remoteUser, { ...expense.data, inviteUrl })
        .catch(e => logger.error('An error happened when creating the COLLECTIVE_EXPENSE_INVITE_DRAFTED activity', e));

      return expense;
    },
  },
};

export default expenseMutations;
