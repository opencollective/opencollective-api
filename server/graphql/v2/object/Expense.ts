import { GraphQLFloat, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { pick } from 'lodash';

import expenseStatus from '../../../constants/expense_status';
import { checkExpense } from '../../../lib/security/expense';
import models, { Op } from '../../../models';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import * as ExpenseLib from '../../common/expenses';
import { CommentCollection } from '../collection/CommentCollection';
import { Currency } from '../enum';
import { ExpenseCurrencySource } from '../enum/ExpenseCurrencySource';
import ExpenseStatus from '../enum/ExpenseStatus';
import { ExpenseType } from '../enum/ExpenseType';
import { FeesPayer } from '../enum/FeesPayer';
import { LegalDocumentType } from '../enum/LegalDocumentType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { Account } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { Activity } from './Activity';
import { Amount } from './Amount';
import ExpenseAttachedFile from './ExpenseAttachedFile';
import ExpenseItem from './ExpenseItem';
import ExpensePermissions from './ExpensePermissions';
import ExpenseQuote from './ExpenseQuote';
import { Host } from './Host';
import { Location } from './Location';
import PayoutMethod from './PayoutMethod';
import RecurringExpense from './RecurringExpense';
import { SecurityCheck } from './SecurityCheck';
import { TaxInfo } from './TaxInfo';
import { VirtualCard } from './VirtualCard';

const EXPENSE_DRAFT_PUBLIC_FIELDS = [
  'items',
  'payee',
  'recipientNote',
  'invitedByCollectiveId',
  'attachedFiles',
  'payoutMethod',
  'payeeLocation',
  'taxes',
];

const loadHostForExpense = async (expense, req) => {
  return expense.HostCollectiveId
    ? req.loaders.Collective.byId.load(expense.HostCollectiveId)
    : req.loaders.Collective.hostByCollectiveId.load(expense.CollectiveId);
};

const Expense = new GraphQLObjectType({
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
        type: Amount,
        description: 'Total amount of the expense',
        args: {
          currencySource: {
            type: ExpenseCurrencySource,
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
        type: new GraphQLNonNull(new GraphQLList(TaxInfo)),
        description: 'Taxes applied to this expense',
        resolve(expense, _, req) {
          if (!expense.data?.taxes) {
            return [];
          } else {
            return expense.data.taxes.map(({ type, rate, idNumber }) => ({
              id: type,
              percentage: rate,
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
      createdAt: {
        type: new GraphQLNonNull(GraphQLDateTime),
        description: 'The time of creation',
      },
      currency: {
        type: new GraphQLNonNull(Currency),
        description: 'Currency that should be used for the payout',
      },
      type: {
        type: new GraphQLNonNull(ExpenseType),
        description: 'Whether this expense is a receipt or an invoice',
      },
      status: {
        type: new GraphQLNonNull(ExpenseStatus),
        description: 'The state of the expense (pending, approved, paid, rejected...etc)',
      },
      comments: {
        type: CommentCollection,
        description: 'Returns the list of comments for this expense, or `null` if user is not allowed to see them',
        args: {
          ...CollectionArgs,
          orderBy: {
            type: ChronologicalOrderInput,
            defaultValue: { field: 'createdAt', direction: 'ASC' },
          },
        },
        async resolve(expense, { limit, offset, orderBy }, req) {
          if (!(await ExpenseLib.canComment(req, expense))) {
            return null;
          }

          return {
            offset,
            limit,
            totalCount: async () => {
              return req.loaders.Comment.countByExpenseId.load(expense.id);
            },
            nodes: async () => {
              return models.Comment.findAll({
                where: { ExpenseId: { [Op.eq]: expense.id } },
                order: [[orderBy.field, orderBy.direction]],
                offset,
                limit,
              });
            },
          };
        },
      },
      account: {
        type: new GraphQLNonNull(Account),
        description: 'The account where the expense was submitted',
        resolve(expense, _, req) {
          return req.loaders.Collective.byId.load(expense.CollectiveId);
        },
      },
      payee: {
        type: new GraphQLNonNull(Account),
        description: 'The account being paid by this expense',
        async resolve(expense, _, req) {
          // Allow users to see account's legal names if they can see expense invoice details
          if (await ExpenseLib.canSeeExpenseInvoiceInfo(req, expense)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_LEGAL_NAME, expense.FromCollectiveId);
          }

          return req.loaders.Collective.byId.load(expense.FromCollectiveId);
        },
      },
      payeeLocation: {
        type: Location,
        description: 'The address of the payee',
        async resolve(expense, _, req) {
          const canSeeLocation = await ExpenseLib.canSeeExpensePayeeLocation(req, expense);
          return !canSeeLocation ? null : { id: `location-expense-${expense.id}`, ...expense.payeeLocation };
        },
      },
      createdByAccount: {
        type: Account,
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
        type: Host,
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
        type: PayoutMethod,
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
        type: VirtualCard,
        description: 'The virtual card used to pay for this charge',
        async resolve(expense, _, req) {
          if (expense.VirtualCardId) {
            return req.loaders.VirtualCard.byId.load(expense.VirtualCardId);
          }
        },
      },
      attachedFiles: {
        type: new GraphQLList(new GraphQLNonNull(ExpenseAttachedFile)),
        description: '(Optional) files attached to the expense',
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseAttachments(req, expense)) {
            return req.loaders.Expense.attachedFiles.load(expense.id);
          }
        },
      },
      items: {
        type: new GraphQLList(ExpenseItem),
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
        type: new GraphQLNonNull(FeesPayer),
        description: 'The fees payer for this expense',
      },
      permissions: {
        type: new GraphQLNonNull(ExpensePermissions),
        description: 'The permissions given to current logged in user for this expense',
        async resolve(expense) {
          return expense; // Individual fields are set by ExpensePermissions's resolvers
        },
      },
      activities: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(Activity))),
        description: 'The list of activities (ie. approved, edited, etc) for this expense ordered by date ascending',
        resolve(expense, _, req) {
          return req.loaders.Expense.activities.load(expense.id);
        },
      },
      tags: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
        resolve(expense) {
          return expense.tags || [];
        },
      },
      requiredLegalDocuments: {
        type: new GraphQLList(LegalDocumentType),
        description:
          'Returns the list of legal documents required from the payee before the expense can be payed. Must be logged in.',
        async resolve(expense, _, req) {
          if (!(await ExpenseLib.canViewRequiredLegalDocuments(req, expense))) {
            return null;
          } else {
            return req.loaders.Expense.requiredLegalDocuments.load(expense.id);
          }
        },
      },
      draft: {
        type: GraphQLJSON,
        description: 'Drafted field values that were still not persisted',
        async resolve(expense) {
          if (expense.status === expenseStatus.DRAFT) {
            return pick(expense.data, EXPENSE_DRAFT_PUBLIC_FIELDS);
          }
        },
      },
      requestedByAccount: {
        type: Account,
        description: 'The account that requested this expense to be submitted',
        async resolve(expense, _, req) {
          if (expense.data?.invitedByCollectiveId) {
            return await req.loaders.Collective.byId.load(expense.data.invitedByCollectiveId);
          }
        },
      },
      quote: {
        type: ExpenseQuote,
        async resolve(expense, _, req) {
          if (await ExpenseLib.canPayExpense(req, expense)) {
            const quote = await ExpenseLib.quoteExpense(expense, { req });
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
      recurringExpense: {
        type: RecurringExpense,
        async resolve(expense) {
          return expense.getRecurringExpense();
        },
      },
      securityChecks: {
        type: new GraphQLList(SecurityCheck),
        async resolve(expense, _, req) {
          if (await ExpenseLib.canSeeExpenseSecurityChecks(req, expense)) {
            return checkExpense(expense);
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
    };
  },
});

export { Expense };
