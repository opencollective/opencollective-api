import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { pick } from 'lodash';

import ACTIVITY from '../../../constants/activities';
import * as ExpenseLib from '../../common/expenses';
import { GraphQLActivityType } from '../enum';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLTransaction } from '../interface/Transaction';

import GraphQLConversation from './Conversation';
import { GraphQLExpense } from './Expense';
import { GraphQLHost } from './Host';
import { GraphQLIndividual } from './Individual';
import { GraphQLOrder } from './Order';
import GraphQLUpdate from './Update';

export const GraphQLActivity = new GraphQLObjectType({
  name: 'Activity',
  description: 'An activity describing something that happened on the platform',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this activity',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACTIVITY),
    },
    type: {
      type: new GraphQLNonNull(GraphQLActivityType),
      description: 'The type of the activity',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the ConnectedAccount was created',
    },
    fromAccount: {
      type: GraphQLAccount,
      description: 'The account that authored by this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.FromCollectiveId) {
          return req.loaders.Collective.byId.load(activity.FromCollectiveId);
        }
      },
    },
    account: {
      type: GraphQLAccount,
      description: 'The account targeted by this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.CollectiveId) {
          return req.loaders.Collective.byId.load(activity.CollectiveId);
        }
      },
    },
    host: {
      type: GraphQLHost,
      description: 'The host under which this activity happened, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.HostCollectiveId) {
          return req.loaders.Collective.byId.load(activity.HostCollectiveId);
        }
      },
    },
    individual: {
      type: GraphQLIndividual,
      description: 'The person who triggered the action, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (!activity.UserId) {
          return null;
        }

        const userCollective = await req.loaders.Collective.byUserId.load(activity.UserId);
        if (!userCollective) {
          return null;
        }

        // We check this just in case, but in practice `Users` are not supposed to be linked to incognito profiles directly
        let isIncognito = userCollective.isIncognito;

        // Check if **the profile** who triggered the action is incognito
        if (!isIncognito && activity.FromCollectiveId) {
          const fromCollective = await req.loaders.Collective.byId.load(activity.FromCollectiveId);
          isIncognito = Boolean(fromCollective?.isIncognito);
        }

        if (isIncognito && !req.remoteUser?.isRoot() && !req.remoteUser?.isAdminOfCollective(userCollective)) {
          return null;
        }

        return userCollective;
      },
    },
    expense: {
      type: GraphQLExpense,
      description: 'The expense related to this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.ExpenseId) {
          return req.loaders.Expense.byId.load(activity.ExpenseId);
        }
      },
    },
    order: {
      type: GraphQLOrder,
      description: 'The order related to this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.OrderId) {
          return req.loaders.Order.byId.load(activity.OrderId);
        }
      },
    },
    update: {
      type: GraphQLUpdate,
      description: 'The update related to this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        const updateId = activity.data.UpdateId || activity.data.update?.id;
        if (updateId) {
          return req.loaders.Update.byId.load(updateId);
        }
      },
    },
    conversation: {
      type: GraphQLConversation,
      description: 'The conversation related to this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        const conversationId = activity.data.ConversationId || activity.data.conversation?.id;
        if (conversationId) {
          return req.loaders.Conversation.byId.load(conversationId);
        }
      },
    },
    transaction: {
      type: GraphQLTransaction,
      description: 'The transaction related to this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.TransactionId) {
          return req.loaders.Transaction.byId.load(activity.TransactionId);
        }
      },
    },
    data: {
      type: new GraphQLNonNull(GraphQLJSON),
      description: 'Data attached to this activity (if any)',
      async resolve(activity, _, req: express.Request): Promise<Record<string, unknown>> {
        const toPick = [];
        if (activity.type === ACTIVITY.COLLECTIVE_EXPENSE_PAID) {
          toPick.push('isManualPayout');
        } else if (activity.type === ACTIVITY.COLLECTIVE_EXPENSE_ERROR) {
          if (activity.CollectiveId) {
            const collective = await req.loaders.Collective.byId.load(activity.CollectiveId);
            if (req.remoteUser?.isAdmin(collective.HostCollectiveId)) {
              toPick.push('error');
            }
          }
        } else if (
          [ACTIVITY.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE, ACTIVITY.COLLECTIVE_EXPENSE_PROCESSING].includes(
            activity.type,
          )
        ) {
          if (activity.ExpenseId) {
            const expense = await req.loaders.Expense.byId.load(activity.ExpenseId);
            if (await ExpenseLib.canSeeExpenseInvoiceInfo(req, expense)) {
              toPick.push('message', 'reference', 'estimatedDelivery');
            }
          }
        } else if (activity.type === ACTIVITY.COLLECTIVE_EXPENSE_MOVED) {
          toPick.push('movedFromCollective');
        } else if (
          [
            ACTIVITY.COLLECTIVE_MEMBER_INVITED,
            ACTIVITY.COLLECTIVE_CORE_MEMBER_INVITED,
            ACTIVITY.COLLECTIVE_CORE_MEMBER_INVITATION_DECLINED,
          ].includes(activity.type)
        ) {
          toPick.push('invitation.role');
        } else if (
          [
            ACTIVITY.COLLECTIVE_MEMBER_CREATED,
            ACTIVITY.COLLECTIVE_CORE_MEMBER_ADDED,
            ACTIVITY.COLLECTIVE_CORE_MEMBER_REMOVED,
            ACTIVITY.COLLECTIVE_CORE_MEMBER_EDITED,
          ].includes(activity.type)
        ) {
          toPick.push('member.role');
          toPick.push('invitation.role');
        } else if (activity.type === ACTIVITY.COLLECTIVE_EDITED) {
          const collective = await req.loaders.Collective.byId.load(activity.CollectiveId);
          if (req.remoteUser?.isAdminOfCollectiveOrHost(collective)) {
            toPick.push('previousData');
            toPick.push('newData');
          }
        } else if (activity.type === ACTIVITY.EXPENSE_COMMENT_CREATED && activity.ExpenseId) {
          const expense = await req.loaders.Expense.byId.load(activity.ExpenseId);
          if (expense && (await ExpenseLib.canComment(req, expense))) {
            toPick.push('comment');
          }
        } else if (activity.type === ACTIVITY.COLLECTIVE_UPDATE_PUBLISHED && !activity.data.update.isPrivate) {
          toPick.push('update.title', 'update.html');
        } else if (activity.type === ACTIVITY.ACCOUNTING_CATEGORIES_EDITED) {
          toPick.push('added', 'removed', 'edited');
        } else if ([ACTIVITY.VENDOR_EDITED, ACTIVITY.VENDOR_CREATED].includes(activity.type)) {
          const collective = await req.loaders.Collective.byId.load(activity.CollectiveId);
          if (req.remoteUser?.isAdminOfCollectiveOrHost(collective)) {
            toPick.push('vendor');
            toPick.push('previousData');
            toPick.push('newData');
          }
        }
        return pick(activity.data, toPick);
      },
    },
    isSystem: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Specifies whether this is a system generated activity',
      resolve: activity => Boolean(activity.data?.isSystem),
    },
  }),
});
