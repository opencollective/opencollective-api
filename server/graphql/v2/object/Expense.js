import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import moment from 'moment';

import { isUserTaxFormRequiredBeforePayment } from '../../../lib/tax-forms';
import models, { Op } from '../../../models';
import { LEGAL_DOCUMENT_TYPE } from '../../../models/LegalDocument';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import * as ExpensePermissionsLib from '../../common/expenses';
import { CommentCollection } from '../collection/CommentCollection';
import { Currency } from '../enum';
import ExpenseStatus from '../enum/ExpenseStatus';
import { ExpenseType } from '../enum/ExpenseType';
import { LegalDocumentType } from '../enum/LegalDocumentType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { Account } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { Activity } from './Activity';
import ExpenseAttachedFile from './ExpenseAttachedFile';
import ExpenseItem from './ExpenseItem';
import ExpensePermissions from './ExpensePermissions';
import { Location } from './Location';
import PayoutMethod from './PayoutMethod';

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
      amount: {
        type: new GraphQLNonNull(GraphQLInt),
        description: "Total amount of the expense (sum of the item's amounts).",
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
          if (!(await ExpensePermissionsLib.canComment(req, expense))) {
            return null;
          }

          const { count, rows } = await models.Comment.findAndCountAll({
            where: {
              ExpenseId: { [Op.eq]: expense.id },
            },
            order: [[orderBy.field, orderBy.direction]],
            offset,
            limit,
          });

          return { offset, limit, totalCount: count, nodes: rows };
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
          return req.loaders.Collective.byId.load(expense.FromCollectiveId);
        },
      },
      payeeLocation: {
        type: Location,
        description: 'The address of the payee',
        async resolve(expense, _, req) {
          const canSeeLocation = await ExpensePermissionsLib.canSeeExpensePayeeLocation(req, expense);
          return !canSeeLocation ? null : expense.payeeLocation;
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
      payoutMethod: {
        type: PayoutMethod,
        description: 'The payout method to use for this expense',
        async resolve(expense, _, req) {
          if (expense.PayoutMethodId) {
            if (await ExpensePermissionsLib.canSeeExpensePayoutMethod(req, expense)) {
              allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, expense.PayoutMethodId);
            }

            return req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId);
          }
        },
      },
      attachedFiles: {
        type: new GraphQLList(new GraphQLNonNull(ExpenseAttachedFile)),
        description: '(Optional) files attached to the expense',
        async resolve(expense, _, req) {
          if (await ExpensePermissionsLib.canSeeExpenseAttachments(req, expense)) {
            return req.loaders.Expense.attachedFiles.load(expense.id);
          }
        },
      },
      attachments: {
        type: new GraphQLList(ExpenseItem),
        deprecationReason: '2020-04-08: Field has been renamed to "items"',
        async resolve(expense, _, req) {
          if (await ExpensePermissionsLib.canSeeExpenseAttachments(req, expense)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, expense.id);
          }

          return ExpensePermissionsLib.getExpenseItems(expense.id, req);
        },
      },
      items: {
        type: new GraphQLList(ExpenseItem),
        async resolve(expense, _, req) {
          if (await ExpensePermissionsLib.canSeeExpenseAttachments(req, expense)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, expense.id);
          }

          return ExpensePermissionsLib.getExpenseItems(expense.id, req);
        },
      },
      privateMessage: {
        type: GraphQLString,
        description: 'Additional information about the payment as HTML. Only visible to user and admins.',
        async resolve(expense, _, req) {
          if (await ExpensePermissionsLib.canSeeExpensePayoutMethod(req, expense)) {
            return expense.privateMessage;
          }
        },
      },
      invoiceInfo: {
        type: GraphQLString,
        description: 'Information to display on the invoice. Only visible to user and admins.',
        async resolve(expense, _, req) {
          if (await ExpensePermissionsLib.canSeeExpenseInvoiceInfo(req, expense)) {
            return expense.invoiceInfo;
          }
        },
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
          if (!req.remoteUser?.isAdmin(expense.FromCollectiveId)) {
            return [];
          }

          const incurredYear = moment(expense.incurredAt).year();
          const isW9FormRequired = await isUserTaxFormRequiredBeforePayment({
            year: incurredYear,
            invoiceTotalThreshold: 600e2,
            expenseCollectiveId: expense.CollectiveId,
            UserId: expense.UserId,
          });

          return isW9FormRequired ? [LEGAL_DOCUMENT_TYPE.US_TAX_FORM] : [];
        },
      },
    };
  },
});

export { Expense };
