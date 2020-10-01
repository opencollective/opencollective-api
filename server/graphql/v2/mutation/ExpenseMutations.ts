import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { omit, pick, size } from 'lodash';
import { v4 as uuid } from 'uuid';

import { types as collectiveTypes } from '../../../constants/collectives';
import expenseStatus from '../../../constants/expense_status';
import FEATURE from '../../../constants/feature';
import { canUseFeature } from '../../../lib/user-permissions';
import models from '../../../models';
import {
  approveExpense,
  canDeleteExpense,
  rejectExpense,
  scheduleExpenseForPayment,
  unapproveExpense,
} from '../../common/expenses';
import { FeatureNotAllowedForUser, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import {
  createExpense as createExpenseLegacy,
  editExpense as editExpenseLegacy,
  markExpenseAsUnpaid as markExpenseAsUnpaidLegacy,
  payExpense as payExpenseLegacy,
} from '../../v1/mutations/expenses';
import { ExpenseProcessAction } from '../enum/ExpenseProcessAction';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ExpenseCreateInput } from '../input/ExpenseCreateInput';
import { ExpenseInviteDraftInput } from '../input/ExpenseInviteDraftInput';
import {
  ExpenseReferenceInput,
  fetchExpenseWithReference,
  getDatabaseIdFromExpenseReference,
} from '../input/ExpenseReferenceInput';
import { ExpenseUpdateInput } from '../input/ExpenseUpdateInput';
import { Expense } from '../object/Expense';

const expenseMutations = {
  createExpense: {
    type: new GraphQLNonNull(Expense),
    description: 'Submit an expense to a collective',
    args: {
      expense: {
        type: new GraphQLNonNull(ExpenseCreateInput),
        description: 'Expense data',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the expense will be created',
      },
    },
    async resolve(_, args, req): Promise<object> {
      const payoutMethod = args.expense.payoutMethod;
      if (payoutMethod.id) {
        payoutMethod.id = idDecode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
      }

      // Support deprecated `attachments` field
      const items = args.expense.items || args.expense.attachments || [];

      // Right now this endpoint uses the old mutation by adapting the data for it. Once we get rid
      // of the `createExpense` endpoint in V1, the actual code to create the expense should be moved
      // here and cleaned.
      return createExpenseLegacy(req.remoteUser, {
        ...pick(args.expense, [
          'description',
          'longDescription',
          'tags',
          'type',
          'privateMessage',
          'attachedFiles',
          'invoiceInfo',
          'payeeLocation',
        ]),
        items,
        amount: items.reduce((total, item) => total + item.amount, 0),
        PayoutMethod: payoutMethod,
        collective: await fetchAccountWithReference(args.account, req),
        fromCollective: await fetchAccountWithReference(args.expense.payee, { throwIfMissing: true }),
      });
    },
  },
  editExpense: {
    type: new GraphQLNonNull(Expense),
    description: 'To update an existing expense',
    args: {
      expense: {
        type: new GraphQLNonNull(ExpenseUpdateInput),
        description: 'Expense data',
      },
    },
    async resolve(_, { expense }, req): Promise<object> {
      // Support deprecated `attachments` field
      const items = expense.items || expense.attachments;

      return editExpenseLegacy(req, {
        id: idDecode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        description: expense.description,
        tags: expense.tags,
        type: expense.type,
        payeeLocation: expense.payeeLocation,
        privateMessage: expense.privateMessage,
        invoiceInfo: expense.invoiceInfo,
        amount: items?.reduce((total, att) => total + att.amount, 0),
        PayoutMethod: expense.payoutMethod && {
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
        attachedFiles: expense.attachedFiles?.map(attachedFile => ({
          id: attachedFile.id && idDecode(attachedFile.id, IDENTIFIER_TYPES.EXPENSE_ITEM),
          url: attachedFile.url,
        })),
        fromCollective: expense.payee && (await fetchAccountWithReference(expense.payee, { throwIfMissing: true })),
      });
    },
  },
  deleteExpense: {
    type: new GraphQLNonNull(Expense),
    description: `Delete an expense. Only work if the expense is rejected - please check permissions.canDelete.`,
    args: {
      expense: {
        type: new GraphQLNonNull(ExpenseReferenceInput),
        description: 'Reference of the expense to delete',
      },
    },
    async resolve(_, args, req): Promise<typeof Expense> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const expenseId = getDatabaseIdFromExpenseReference(args.expense);
      const expense = await models.Expense.findByPk(expenseId, {
        // Need to load the collective because canDeleteExpense checks expense.collective.HostCollectiveId
        include: [{ model: models.Collective, as: 'collective' }],
      });

      if (!expense) {
        throw new NotFound('Expense not found');
      } else if (!(await canDeleteExpense(req, expense))) {
        throw new Unauthorized(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      }

      return expense.destroy();
    },
  },
  processExpense: {
    type: new GraphQLNonNull(Expense),
    description: 'Process the expense with the given action',
    args: {
      expense: {
        type: new GraphQLNonNull(ExpenseReferenceInput),
        description: 'Reference of the expense to process',
      },
      action: {
        type: new GraphQLNonNull(ExpenseProcessAction),
        description: 'The action to trigger',
      },
      paymentParams: {
        description: 'If action is related to a payment, this object used for the payment parameters',
        type: new GraphQLInputObjectType({
          name: 'ProcessExpensePaymentParams',
          description: 'Parameters for paying an expense',
          fields: {
            paymentProcessorFee: {
              type: GraphQLInt,
              description:
                'The fee charged by payment processor in collective currency, or the fee refunded when used with MARK_AS_UNPAID',
            },
            forceManual: {
              type: GraphQLBoolean,
              description: 'Bypass automatic integrations (ie. PayPal, Transferwise) to process the expense manually',
            },
            twoFactorAuthenticatorCode: {
              type: GraphQLString,
              description: '2FA code for if the host account has 2FA for payouts turned on.',
            },
          },
        }),
      },
    },
    async resolve(_, args, req): Promise<typeof Expense> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const expense = await fetchExpenseWithReference(args.expense, { loaders: req.loaders, throwIfMissing: true });
      switch (args.action) {
        case 'APPROVE':
          return approveExpense(req, expense);
        case 'UNAPPROVE':
          return unapproveExpense(req, expense);
        case 'REJECT':
          return rejectExpense(req, expense);
        case 'MARK_AS_UNPAID':
          return markExpenseAsUnpaidLegacy(req, expense.id, args.paymentParams?.paymentProcessorFee);
        case 'SCHEDULE_FOR_PAYMENT':
          return scheduleExpenseForPayment(req, expense);
        case 'PAY':
          return payExpenseLegacy(req, {
            id: expense.id,
            paymentProcessorFeeInCollectiveCurrency: args.paymentParams?.paymentProcessorFee,
            forceManual: args.paymentParams?.forceManual,
            twoFactorAuthenticatorCode: args.paymentParams?.twoFactorAuthenticatorCode,
          });
        default:
          return expense;
      }
    },
  },
  draftExpenseAndInviteUser: {
    type: new GraphQLNonNull(Expense),
    description: 'Persist an Expense as a draft and invite someone to edit and submit it.',
    args: {
      expense: {
        type: new GraphQLNonNull(ExpenseInviteDraftInput),
        description: 'Expense data',
      },
      account: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'Account where the expense will be created',
      },
    },
    async resolve(_, args, req): Promise<object> {
      const remoteUser = req.remoteUser;
      const expenseData = args.expense;

      if (!remoteUser) {
        throw new Unauthorized('You need to be logged in to create an expense');
      } else if (!canUseFeature(remoteUser, FEATURE.EXPENSES)) {
        throw new FeatureNotAllowedForUser();
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

      const draftKey = uuid();
      const expenseFields = [
        'description',
        'longDescription',
        'tags',
        'type',
        'privateMessage',
        'invoiceInfo',
        'payeeLocation',
      ];

      const fromCollective = await remoteUser.getCollective();
      const payee = expenseData.payee?.id
        ? (await fetchAccountWithReference({ id: expenseData.payee.id }))?.minimal
        : expenseData.payee;
      const expense = await models.Expense.create({
        ...pick(expenseData, expenseFields),
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        lastEditedById: remoteUser.id,
        UserId: remoteUser.id,
        currency: collective.currency,
        incurredAt: new Date(),
        amount: expenseData.items?.reduce((total, item) => total + item.amount, 0) || expenseData.amount || 1,
        data: {
          items: expenseData.items,
          payee,
          invitedByCollectiveId: fromCollective.id,
          draftKey,
          recipientNote: expenseData.recipientNote,
        },
        status: expenseStatus.DRAFT,
      });

      const inviteUrl = `${config.host.website}/${collective.slug}/expenses/${expense.id}?key=${draftKey}`;
      expense
        .createActivity(activityType.COLLECTIVE_EXPENSE_INVITE_DRAFTED, remoteUser, { ...expense.data, inviteUrl })
        .catch(e => logger.error('An error happened when creating the COLLECTIVE_EXPENSE_INVITE_DRAFTED activity', e));

      if (config.env === 'development') {
        logger.info(`Expense Invite Link: ${inviteUrl}`);
      }

      return expense;
    },
  },
      return expense;
    },
  },
};

export default expenseMutations;
