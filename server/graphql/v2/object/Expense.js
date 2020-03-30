import { GraphQLString, GraphQLObjectType, GraphQLInt, GraphQLNonNull, GraphQLList } from 'graphql';

import models, { Op } from '../../../models';
import { PERMISSION_TYPE, allowContextPermission } from '../../common/context-permissions';
import * as ExpensePermissionsLib from '../../common/expenses';
import { CommentCollection } from '../collection/CommentCollection';
import { Currency } from '../enum';
import ExpenseStatus from '../enum/ExpenseStatus';
import { ExpenseType } from '../enum/ExpenseType';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { Account } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import ExpenseAttachment from './ExpenseAttachment';
import ExpensePermissions from './ExpensePermissions';
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
        description: 'Total amount of the expense (sum of the attachments).',
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
        type: new GraphQLNonNull(CommentCollection),
        args: {
          ...CollectionArgs,
          orderBy: {
            type: ChronologicalOrderInput,
            defaultValue: { field: 'createdAt', direction: 'ASC' },
          },
        },
        async resolve(expense, { limit, offset, orderBy }) {
          const { count, rows } = await models.Comment.findAndCountAll({
            where: {
              ExpenseId: { [Op.eq]: expense.id },
            },
            order: [[orderBy.field, orderBy.direction]],
            offset,
            limit,
          });
          return {
            offset,
            limit,
            totalCount: count,
            nodes: rows,
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
          // Set the permissions for account's fields
          const canSeeLocation = await ExpensePermissionsLib.canSeeExpensePayeeLocation(req, expense);
          if (canSeeLocation) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_LOCATION, expense.FromCollectiveId, true);
          }

          // Return fromCollective
          return req.loaders.Collective.byId.load(expense.FromCollectiveId);
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
            if (await ExpensePermissionsLib.canSeeExpensePayoutMethod(expense, req)) {
              allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, expense.PayoutMethodId);
            }

            return req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId);
          }
        },
      },
      attachments: {
        type: new GraphQLList(ExpenseAttachment),
        async resolve(expense, _, req) {
          if (await ExpensePermissionsLib.canSeeExpenseAttachments(req, expense)) {
            allowContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_ATTACHMENTS_URL, expense.id);
          }

          return ExpensePermissionsLib.getExpenseAttachments(expense.id, req);
        },
      },
      privateMessage: {
        type: GraphQLString,
        description: 'Additional information about the payment. Only visible to user and admins.',
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
    };
  },
});

export { Expense };
