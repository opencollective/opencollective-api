import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick, size } from 'lodash';
import { v4 as uuid } from 'uuid';

import activities from '../../../constants/activities';
import { types as collectiveTypes } from '../../../constants/collectives';
import expenseStatus from '../../../constants/expense_status';
import FEATURE from '../../../constants/feature';
import logger from '../../../lib/logger';
import RateLimit from '../../../lib/rate-limit';
import { canUseFeature } from '../../../lib/user-permissions';
import models from '../../../models';
import {
  approveExpense,
  canDeleteExpense,
  canVerifyDraftExpense,
  createExpense,
  editExpense,
  markExpenseAsSpam,
  markExpenseAsUnpaid,
  payExpense,
  rejectExpense,
  scheduleExpenseForPayment,
  unapproveExpense,
  unscheduleExpensePayment,
} from '../../common/expenses';
import { createUser } from '../../common/user';
import { FeatureNotAllowedForUser, NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';
import { ExpenseProcessAction } from '../enum/ExpenseProcessAction';
import { FeesPayer } from '../enum/FeesPayer';
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
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      const payoutMethod = args.expense.payoutMethod;
      if (payoutMethod.id) {
        payoutMethod.id = idDecode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD);
      }

      // Support deprecated `attachments` field
      const items = args.expense.items || args.expense.attachments || [];

      // Right now this endpoint uses the old mutation by adapting the data for it. Once we get rid
      // of the `createExpense` endpoint in V1, the actual code to create the expense should be moved
      // here and cleaned.
      return createExpense(req.remoteUser, {
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
        payoutMethod,
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
      draftKey: {
        type: GraphQLString,
        description: 'Expense draft key if invited to submit expense',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      // Support deprecated `attachments` field
      const items = args.expense.items || args.expense.attachments;
      const expense = args.expense;
      const payeeExists = expense.payee?.id || expense.payee?.legacyId;

      const expenseData = {
        id: idDecode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        description: expense.description,
        tags: expense.tags,
        type: expense.type,
        payeeLocation: expense.payeeLocation,
        privateMessage: expense.privateMessage,
        invoiceInfo: expense.invoiceInfo,
        amount: items?.reduce((total, att) => total + att.amount, 0),
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
        attachedFiles: expense.attachedFiles?.map(attachedFile => ({
          id: attachedFile.id && idDecode(attachedFile.id, IDENTIFIER_TYPES.EXPENSE_ITEM),
          url: attachedFile.url,
        })),
        fromCollective: payeeExists && (await fetchAccountWithReference(expense.payee, { throwIfMissing: true })),
      };

      if (args.draftKey) {
        // It is a submit on behalf being completed
        const expenseId = getDatabaseIdFromExpenseReference(args.expense);
        let existingExpense = await models.Expense.findByPk(expenseId, {
          include: [{ model: models.Collective, as: 'collective' }],
        });
        if (!existingExpense) {
          throw new NotFound('Expense not found.');
        }
        if (existingExpense.status !== expenseStatus.DRAFT) {
          throw new Unauthorized('Expense can not be edited.');
        }
        if (existingExpense.data.draftKey !== args.draftKey) {
          throw new Unauthorized('You need to submit the right draft key to edit this expense');
        }

        const options = { overrideRemoteUser: undefined, skipPermissionCheck: true };
        if (!payeeExists) {
          const { organization: organizationData, ...payee } = expense.payee;
          const { user, organization } = await createUser(
            {
              ...pick(payee, ['email', 'legalName', 'newsletterOptIn']),
              ...models.User.splitName(payee.name),
              location: expenseData.payeeLocation,
            },
            {
              organizationData,
              throwIfExists: true,
              sendSignInLink: true,
              redirect: `/${existingExpense.collective.slug}/expenses/${expenseId}`,
              creationRequest: {
                ip: req.ip,
                userAgent: req.header?.['user-agent'],
              },
            },
          );
          expenseData.fromCollective = organization || user.collective;
          options.overrideRemoteUser = user;
          options.skipPermissionCheck = true;
        }

        existingExpense = await editExpense(req, expenseData, options);

        await existingExpense.update({
          status: options.overrideRemoteUser?.id ? expenseStatus.UNVERIFIED : undefined,
          lastEditedById: options.overrideRemoteUser?.id || req.remoteUser?.id,
          UserId: options.overrideRemoteUser?.id || req.remoteUser?.id,
        });

        return existingExpense;
      }

      return editExpense(req, expenseData);
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
    async resolve(_: void, args, req: express.Request): Promise<typeof Expense> {
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
          fields: () => ({
            paymentProcessorFee: {
              type: GraphQLInt,
              description: 'The fee charged by payment processor in collective currency',
            },
            shouldRefundPaymentProcessorFee: {
              type: GraphQLBoolean,
              description: 'Whether the payment processor fees should be refunded when triggering MARK_AS_UNPAID',
            },
            forceManual: {
              type: GraphQLBoolean,
              description: 'Bypass automatic integrations (ie. PayPal, Transferwise) to process the expense manually',
            },
            twoFactorAuthenticatorCode: {
              type: GraphQLString,
              description: '2FA code for if the host account has 2FA for payouts turned on.',
            },
            feesPayer: {
              type: FeesPayer,
              description: '2FA code for if the host account has 2FA for payouts turned on.',
              defaultValue: 'COLLECTIVE',
            },
          }),
        }),
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<typeof Expense> {
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
        case 'MARK_AS_SPAM':
          return markExpenseAsSpam(req, expense);
        case 'MARK_AS_UNPAID':
          return markExpenseAsUnpaid(
            req,
            expense.id,
            args.paymentParams?.shouldRefundPaymentProcessorFee || args.paymentParams?.paymentProcessorFee,
          );
        case 'SCHEDULE_FOR_PAYMENT':
          return scheduleExpenseForPayment(req, expense, args.paymentParams?.feesPayer);
        case 'UNSCHEDULE_PAYMENT':
          return unscheduleExpensePayment(req, expense);
        case 'PAY':
          return payExpense(req, {
            id: expense.id,
            paymentProcessorFeeInCollectiveCurrency: args.paymentParams?.paymentProcessorFee,
            forceManual: args.paymentParams?.forceManual,
            twoFactorAuthenticatorCode: args.paymentParams?.twoFactorAuthenticatorCode,
            feesPayer: args.paymentParams?.feesPayer,
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
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      const remoteUser = req.remoteUser;
      const expenseData = args.expense;

      const rateLimit = new RateLimit(`draft_expense_${remoteUser.id}`, 1, 10, true);
      if (!(await rateLimit.registerCall())) {
        throw new RateLimitExceeded();
      }

      if (!remoteUser) {
        throw new Unauthorized('You need to be logged in to create an expense');
      } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
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

      const draftKey = process.env.OC_ENV === 'e2e' || process.env.OC_ENV === 'ci' ? 'draft-key' : uuid();
      const expenseFields = ['description', 'longDescription', 'tags', 'type', 'privateMessage', 'invoiceInfo'];

      const fromCollective = await remoteUser.getCollective();
      const payee = expenseData.payee?.id
        ? (await fetchAccountWithReference({ id: expenseData.payee.id }, { throwIfMissing: true }))?.minimal
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
          attachedFiles: expenseData.attachedFiles,
          payee,
          invitedByCollectiveId: fromCollective.id,
          draftKey,
          recipientNote: expenseData.recipientNote,
          payoutMethod: expenseData.payoutMethod,
          payeeLocation: expenseData.payeeLocation,
        },
        status: expenseStatus.DRAFT,
      });

      const inviteUrl = `${config.host.website}/${collective.slug}/expenses/${expense.id}?key=${draftKey}`;
      expense
        .createActivity(activities.COLLECTIVE_EXPENSE_INVITE_DRAFTED, remoteUser, { ...expense.data, inviteUrl })
        .catch(e => logger.error('An error happened when creating the COLLECTIVE_EXPENSE_INVITE_DRAFTED activity', e));

      if (config.env === 'development') {
        logger.info(`Expense Invite Link: ${inviteUrl}`);
      }

      return expense;
    },
  },
  resendDraftExpenseInvite: {
    type: new GraphQLNonNull(Expense),
    description: 'To verify an unverified expense.',
    args: {
      expense: {
        type: new GraphQLNonNull(ExpenseReferenceInput),
        description: 'Reference of the expense to process',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
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
        throw new Unauthorized("You don't have the permission to edit this expense.");
      }

      const draftKey = expense.data.draftKey;
      const inviteUrl = `${config.host.website}/${expense.collective.slug}/expenses/${expense.id}?key=${draftKey}`;
      expense
        .createActivity(activities.COLLECTIVE_EXPENSE_INVITE_DRAFTED, req.remoteUser, { ...expense.data, inviteUrl })
        .catch(e => logger.error('An error happened when creating the COLLECTIVE_EXPENSE_INVITE_DRAFTED activity', e));

      return expense;
    },
  },
  verifyExpense: {
    type: new GraphQLNonNull(Expense),
    description: 'To verify and unverified expense.',
    args: {
      expense: {
        type: new GraphQLNonNull(ExpenseReferenceInput),
        description: 'Reference of the expense to process',
      },
      draftKey: {
        type: GraphQLString,
        description: 'Expense draft key if invited to submit expense',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<Record<string, unknown>> {
      const expense = await fetchExpenseWithReference(args.expense, { throwIfMissing: true });
      if (expense.status !== expenseStatus.UNVERIFIED) {
        throw new Unauthorized('Expense can not be verified.');
      } else if (!(await canVerifyDraftExpense(req, expense))) {
        throw new Unauthorized("You don't have the permission to edit this expense.");
      }
      await expense.update({ status: expenseStatus.PENDING });

      // Technically the expense was already created, but it was a draft. It truly becomes visible
      // for everyone (especially admins) at this point, so it's the right time to trigger `COLLECTIVE_EXPENSE_CREATED`
      await expense
        .createActivity(activities.COLLECTIVE_EXPENSE_CREATED, req.remoteUser)
        .catch(e => logger.error('An error happened when creating the COLLECTIVE_EXPENSE_CREATED activity', e));

      return expense;
    },
  },
};

export default expenseMutations;
