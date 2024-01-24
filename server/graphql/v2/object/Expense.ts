import express from 'express';
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { pick, round, takeRightWhile, toString, uniq } from 'lodash';

import ActivityTypes from '../../../constants/activities';
import expenseStatus from '../../../constants/expense-status';
import ExpenseTypes from '../../../constants/expense-type';
import models, { Activity } from '../../../models';
import { CommentType } from '../../../models/Comment';
import ExpenseModel from '../../../models/Expense';
import { LEGAL_DOCUMENT_TYPE } from '../../../models/LegalDocument';
import transferwise from '../../../paymentProviders/transferwise';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import * as ExpenseLib from '../../common/expenses';
import { CommentCollection } from '../collection/CommentCollection';
import { GraphQLCurrency } from '../enum';
import { GraphQLExpenseCurrencySource } from '../enum/ExpenseCurrencySource';
import GraphQLExpenseStatus from '../enum/ExpenseStatus';
import { GraphQLExpenseType } from '../enum/ExpenseType';
import { GraphQLFeesPayer } from '../enum/FeesPayer';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { GraphQLAccount } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { GraphQLAccountingCategory } from './AccountingCategory';
import { GraphQLActivity } from './Activity';
import { GraphQLAmount } from './Amount';
import GraphQLExpenseAttachedFile from './ExpenseAttachedFile';
import GraphQLExpenseItem from './ExpenseItem';
import GraphQLExpensePermissions from './ExpensePermissions';
import GraphQLExpenseQuote from './ExpenseQuote';
import { GraphQLExpenseValuesByRole } from './ExpenseValuesByRole';
import { GraphQLHost } from './Host';
import { GraphQLLocation } from './Location';
import GraphQLPayoutMethod from './PayoutMethod';
import GraphQLRecurringExpense from './RecurringExpense';
import { GraphQLSecurityCheck } from './SecurityCheck';
import { GraphQLTaxInfo } from './TaxInfo';
import { GraphQLTransferWiseRequiredField } from './TransferWise';
import { GraphQLVirtualCard } from './VirtualCard';

const EXPENSE_DRAFT_PUBLIC_FIELDS = [
  'taxes',
  'invitedByCollectiveId',
  'payee.name',
  'payee.slug',
  'payee.id',
  'payee.organization',
];
const EXPENSE_DRAFT_PRIVATE_FIELDS = [
  'recipientNote',
  'attachedFiles',
  'payoutMethod',
  'payeeLocation',
  'payee.email',
  'payee.legalName',
];
const EXPENSE_DRAFT_ITEMS_PUBLIC_FIELDS = [
  'id',
  'amount',
  'amountV2',
  'currency',
  'expenseCurrencyFxRate',
  'expenseCurrencyFxRateSource',
  'incurredAt',
  'description',
];
const EXPENSE_DRAFT_ITEMS_PRIVATE_FIELDS = ['url'];

const loadHostForExpense = async (expense, req) => {
  return expense.HostCollectiveId
    ? req.loaders.Collective.byId.load(expense.HostCollectiveId)
    : req.loaders.Collective.hostByCollectiveId.load(expense.CollectiveId);
};

export const GraphQLExpense = new GraphQLObjectType<ExpenseModel, express.Request>({
  name: 'Expense',
  description: 'This represents an Expense',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE),
      },
      legacyId: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'Legacy ID as returned by API V1. Avoid relying on this field as it may be removed in the future.',
        resolve(expense) {
          return expense.id;
        },
      },
      description: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Title/main description for this expense',
      },
      longDescription: {
        type: GraphQLString,
        description: 'Longer description for this expense',
      },
      amount: {
        type: new GraphQLNonNull(GraphQLInt),
        description: "Total amount of the expense (sum of the item's amounts).",
        deprecationReason: '2022-02-09: Please use amountV2',
      },
      amountV2: {
        type: GraphQLAmount,
        description: 'Total amount of the expense',
        args: {
          currencySource: {
            type: GraphQLExpenseCurrencySource,
            description: 'Source of the currency to express the amount. Defaults to the expense currency',
            defaultValue: 'EXPENSE',
          },
        },
        async resolve(expense, args, req) {
          let currency = expense.currency;

          // Pick the right currency based on args
          if (args.currencySource === 'ACCOUNT') {
            expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));
            currency = expense.collective?.currency;
          } else if (args.currencySource === 'HOST') {
            const host = await loadHostForExpense(expense, req);
            currency = host?.currency;
          } else if (args.currencySource === 'CREATED_BY_ACCOUNT') {
            expense.User = expense.User || (await req.loaders.User.byId.load(expense.UserId));
            if (expense.User) {
              expense.User.collective =
                expense.User.collective || (await req.loaders.Collective.byId.load(expense.User.CollectiveId));
              currency = expense.User?.collective?.currency || 'USD';
            }
          }

          // Return null if the currency can't be looked up (e.g. asking for the host currency when the collective has no fiscal host)
          if (!currency) {
            return null;
          }

          return ExpenseLib.getExpenseAmountInDifferentCurrency(expense, currency, req);
        },
      },
      taxes: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLTaxInfo)),
        description: 'Taxes applied to this expense',
        resolve(expense, _, req) {
          if (!expense.data?.taxes) {
            return [];
          } else {
            return (expense.data.taxes as any[]).map(({ type, rate, idNumber }) => ({
              id: type,
              percentage: round(rate * 100, 2),
              type,
              rate,
              idNumber: async () => {
                const canSeePayoutDetails = await ExpenseLib.canSeeExpenseInvoiceInfo(req, expense);
                return canSeePayoutDetails ? idNumber : null;
              },
            }));
          }
        },
      },
      accountCurrencyFxRate: {
        type: new GraphQLNonNull(GraphQLFloat),
        description: 'The exchange rate between the expense currency and the account currency',
        deprecationReason: '2022-02-09: Please use amountV2',
        async resolve(expense, args, req) {
          expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));
          if (expense.collective.currency === expense.currency) {
            return 1;
          } else {
            return req.loaders.CurrencyExchangeRate.fxRate.load({
              fromCurrency: expense.currency,
              toCurrency: expense.collective.currency,
            });
          }
        },
      },
      accountingCategory: {
        type: GraphQLAccountingCategory,
        description: 'The accounting category attached to this expense',
        async resolve(expense, _, req) {
          if (expense.AccountingCategoryId) {
            return req.loaders.AccountingCategory.byId.load(expense.AccountingCategoryId);
          }
        },
      },
      valuesByRole: {
        type: GraphQLExpenseValuesByRole,
        description:
          'If available, this field will contain a breakdown of the expense values depending on who edited it',
        resolve: expense => expense, // Fields resolved in GraphQLExpenseValuesByRole
      },
      createdAt: {
        type: new GraphQLNonNull(GraphQLDateTime),
        description: 'The time of creation',
      },
      currency: {
        type: new GraphQLNonNull(GraphQLCurrency),
        description: 'Currency that should be used for the payout',
      },
      type: {
        type: new GraphQLNonNull(GraphQLExpenseType),
        description: 'Whether this expense is a receipt or an invoice',
      },
      status: {
        type: new GraphQLNonNull(GraphQLExpenseStatus),
        description: 'The state of the expense (pending, approved, paid, rejected...etc)',
      },
      approvedBy: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLAccount)),
        description: 'The accounts who approved this expense',
        async resolve(expense, _, req) {
          const activities: Activity[] = await req.loaders.Expense.activities.load(expense.id);
          const approvalActivitiesSinceLastUnapprovedState = takeRightWhile(
            activities,
            a =>
              ![
                ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
                ActivityTypes.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
                ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
              ].includes(a.type),
          ).filter(a => a.type === ActivityTypes.COLLECTIVE_EXPENSE_APPROVED);

          const approvingUserIds = uniq(
            approvalActivitiesSinceLastUnapprovedState.map(a => a.UserId).filter(userId => !!userId),
          );
          if (approvingUserIds.length === 0) {
            return [];
          }

          return await req.loaders.Collective.byUserId.loadMany(approvingUserIds);
        },
      },
      onHold: {
        type: GraphQLBoolean,
        description: 'Whether this expense is on hold',
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseOnHoldFlag(req, expense)) {
            return expense.onHold;
          }
        },
      },
      comments: {
        type: CommentCollection,
        description: 'Returns the list of comments for this expense, or `null` if user is not allowed to see them',
        args: {
          ...CollectionArgs,
          orderBy: {
            type: GraphQLChronologicalOrderInput,
            defaultValue: { field: 'createdAt', direction: 'ASC' },
          },
        },
        async resolve(expense, { limit, offset, orderBy }, req) {
          if (!(await ExpenseLib.canComment(req, expense))) {
            return null;
          }

          const type = [CommentType.COMMENT];
          if (await ExpenseLib.canUsePrivateNotes(req, expense)) {
            type.push(CommentType.PRIVATE_NOTE);
          }

          return {
            offset,
            limit,
            totalCount: async () => req.loaders.Comment.countByExpenseAndType.load({ ExpenseId: expense.id, type }),
            nodes: async () =>
              models.Comment.findAll({
                where: { ExpenseId: expense.id, type },
                order: [[orderBy.field, orderBy.direction]],
                offset,
                limit,
              }),
          };
        },
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccount),
        description: 'The account where the expense was submitted',
        resolve(expense, _, req) {
          return req.loaders.Collective.byId.load(expense.CollectiveId);
        },
      },
      payee: {
        type: new GraphQLNonNull(GraphQLAccount),
        description: 'The account being paid by this expense',
        async resolve(expense, _, req) {
          // Allow users to see account's legal names if they can see expense invoice details
          if (await ExpenseLib.canSeeExpenseInvoiceInfo(req, expense)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_PRIVATE_PROFILE_INFO, expense.FromCollectiveId);
          }

          return req.loaders.Collective.byId.load(expense.FromCollectiveId);
        },
      },
      payeeLocation: {
        type: GraphQLLocation,
        description: 'The address of the payee',
        async resolve(expense, _, req) {
          const canSeeLocation = await ExpenseLib.canSeeExpensePayeeLocation(req, expense);
          return !canSeeLocation ? null : { id: `location-expense-${expense.id}`, ...expense.payeeLocation };
        },
      },
      createdByAccount: {
        type: GraphQLAccount,
        description: 'The account who created this expense',
        async resolve(expense, _, req) {
          const user = await req.loaders.User.byId.load(expense.UserId);
          if (user && user.CollectiveId) {
            const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
            if (collective && !collective.isIncognito) {
              return collective;
            }
          }
        },
      },
      host: {
        type: GraphQLHost,
        description: 'The account from where the expense was paid',
        async resolve(expense, _, req) {
          if (expense.HostCollectiveId) {
            return req.loaders.Collective.byId.load(expense.HostCollectiveId);
          } else {
            return req.loaders.Collective.hostByCollectiveId.load(expense.CollectiveId);
          }
        },
      },
      payoutMethod: {
        type: GraphQLPayoutMethod,
        description: 'The payout method to use for this expense',
        async resolve(expense, _, req) {
          if (expense.PayoutMethodId) {
            if (await ExpenseLib.canSeeExpensePayoutMethod(req, expense)) {
              allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, expense.PayoutMethodId);
            }

            return req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId);
          }
        },
      },
      virtualCard: {
        type: GraphQLVirtualCard,
        description: 'The virtual card used to pay for this charge',
        async resolve(expense, _, req) {
          if (expense.VirtualCardId) {
            return req.loaders.VirtualCard.byId.load(expense.VirtualCardId);
          }
        },
      },
      attachedFiles: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLExpenseAttachedFile)),
        description: '(Optional) files attached to the expense',
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseAttachments(req, expense)) {
            return req.loaders.Expense.attachedFiles.load(expense.id);
          }
        },
      },
      items: {
        type: new GraphQLList(GraphQLExpenseItem),
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseAttachments(req, expense)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, expense.id);
          }

          return req.loaders.Expense.items.load(expense.id);
        },
      },
      privateMessage: {
        type: GraphQLString,
        description: 'Additional information about the payment as HTML. Only visible to user and admins.',
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpensePayoutMethod(req, expense)) {
            return expense.privateMessage;
          }
        },
      },
      invoiceInfo: {
        type: GraphQLString,
        description: 'Information to display on the invoice. Only visible to user and admins.',
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseInvoiceInfo(req, expense)) {
            return expense.invoiceInfo;
          }
        },
      },
      feesPayer: {
        type: new GraphQLNonNull(GraphQLFeesPayer),
        description: 'The fees payer for this expense',
      },
      permissions: {
        type: new GraphQLNonNull(GraphQLExpensePermissions),
        description: 'The permissions given to current logged in user for this expense',
        async resolve(expense) {
          return expense; // Individual fields are set by ExpensePermissions's resolvers
        },
      },
      activities: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLActivity))),
        description: 'The list of activities (ie. approved, edited, etc) for this expense ordered by date ascending',
        async resolve(expense, _, req) {
          const activities = await req.loaders.Expense.activities.load(expense.id);
          if (!req.remoteUser || !(await ExpenseLib.canSeeExpenseOnHoldFlag(req, expense))) {
            return activities.filter(
              activity =>
                ![
                  ActivityTypes.COLLECTIVE_EXPENSE_PUT_ON_HOLD,
                  ActivityTypes.COLLECTIVE_EXPENSE_RELEASED_FROM_HOLD,
                ].includes(activity.type),
            );
          }
          return activities;
        },
      },
      tags: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
        resolve(expense) {
          return expense.tags || [];
        },
      },
      requiredLegalDocuments: {
        type: new GraphQLList(GraphQLLegalDocumentType),
        description:
          'Returns the list of legal documents required from the payee before the expense can be payed. Must be logged in.',
        async resolve(expense, _, req) {
          if (!(await ExpenseLib.canViewRequiredLegalDocuments(req, expense))) {
            return null;
          } else if (await req.loaders.Expense.taxFormRequiredBeforePayment.load(expense.id)) {
            return [LEGAL_DOCUMENT_TYPE.US_TAX_FORM];
          } else {
            return [];
          }
        },
      },
      draft: {
        type: GraphQLJSON,
        description: 'Drafted field values that were still not persisted',
        async resolve(expense, _, req) {
          if (expense.status === expenseStatus.DRAFT) {
            let draftFields = EXPENSE_DRAFT_PUBLIC_FIELDS;
            let itemsFields = EXPENSE_DRAFT_ITEMS_PUBLIC_FIELDS;
            if (await ExpenseLib.canSeeExpenseDraftPrivateDetails(req, expense)) {
              draftFields = [...draftFields, ...EXPENSE_DRAFT_PRIVATE_FIELDS];
              itemsFields = [...itemsFields, ...EXPENSE_DRAFT_ITEMS_PRIVATE_FIELDS];
            }

            const draftData = pick(expense.data, draftFields);
            if (expense.data?.items) {
              draftData.items = (expense.data.items as any[]).map(item => pick(item, itemsFields));
            }

            return draftData;
          }
        },
      },
      requestedByAccount: {
        type: GraphQLAccount,
        description: 'The account that requested this expense to be submitted',
        async resolve(expense, _, req) {
          if (expense.data?.invitedByCollectiveId) {
            return await req.loaders.Collective.byId.load(expense.data.invitedByCollectiveId);
          }
        },
      },
      quote: {
        type: GraphQLExpenseQuote,
        async resolve(expense, _, req) {
          const isScheduledForPayment = expense.status === 'SCHEDULED_FOR_PAYMENT';
          const canSeeQuote = isScheduledForPayment
            ? await ExpenseLib.canUnschedulePayment(req, expense)
            : await ExpenseLib.canPayExpense(req, expense);
          if (canSeeQuote) {
            const quote = isScheduledForPayment ? expense.data?.quote : await ExpenseLib.quoteExpense(expense, { req });

            const sourceAmount = {
              value: quote.paymentOption.sourceAmount * 100,
              currency: quote.paymentOption.sourceCurrency,
            };
            const estimatedDeliveryAt = quote.paymentOption.estimatedDelivery;
            const paymentProcessorFeeAmount = {
              value: quote.paymentOption.fee.total * 100,
              currency: quote.sourceCurrency,
            };
            return { sourceAmount, estimatedDeliveryAt, paymentProcessorFeeAmount };
          }
        },
      },
      validateTransferRequirements: {
        type: new GraphQLList(GraphQLTransferWiseRequiredField),
        args: {
          details: {
            type: GraphQLJSON,
            description: 'Details of the transfer',
          },
        },
        async resolve(expense, args, req) {
          const payoutMethod = await req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId);
          if (payoutMethod?.type === 'BANK_ACCOUNT' && (await ExpenseLib.canPayExpense(req, expense))) {
            const collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
            const host = await collective.getHostCollective({ loaders: req.loaders });
            const [connectedAccount] = await host.getConnectedAccounts({
              where: { service: 'transferwise', deletedAt: null },
            });
            return await transferwise.validateTransferRequirements(
              connectedAccount,
              payoutMethod,
              expense,
              args.details,
            );
          }
        },
      },
      recurringExpense: {
        type: GraphQLRecurringExpense,
        async resolve(expense) {
          return expense.getRecurringExpense();
        },
      },
      securityChecks: {
        type: new GraphQLList(GraphQLSecurityCheck),
        description: '[Admin only] Security checks for this expense. Only available to expenses under trusted hosts.',
        async resolve(expense, _, req) {
          if (expense.type === ExpenseTypes.CHARGE) {
            return null;
          } else if (await ExpenseLib.canSeeExpenseSecurityChecks(req, expense)) {
            return req.loaders.Expense.securityChecks.load(expense);
          }
        },
      },
      customData: {
        type: GraphQLJSON,
        description: 'Custom data for this expense',
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseCustomData(req, expense)) {
            return expense.data?.customData || null;
          }
        },
      },
      merchantId: {
        type: GraphQLString,
        description: 'The merchant ID for this expense',
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseCustomData(req, expense)) {
            return (
              toString(
                expense.data?.transactionId ||
                  expense.data?.transfer?.id ||
                  expense.data?.transaction_id ||
                  expense.data?.batchGroup?.id,
              ) || null
            );
          }
        },
      },
    };
  },
});
