import express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { pick } from 'lodash';

import ACTIVITY from '../../../constants/activities';
import * as ExpenseLib from '../../common/expenses';
import { ActivityType } from '../enum';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';
import { Transaction } from '../interface/Transaction';

import { Expense } from './Expense';
import { Host } from './Host';
import { Individual } from './Individual';
import { Order } from './Order';

export const Activity = new GraphQLObjectType({
  name: 'Activity',
  description: 'An activity describing something that happened on the platform',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this activity',
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACTIVITY),
    },
    type: {
      type: new GraphQLNonNull(ActivityType),
      description: 'The type of the activity',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the ConnectedAccount was created',
    },
    fromAccount: {
      type: Account,
      description: 'The account that authored by this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.FromCollectiveId) {
          return req.loaders.Collective.byId.load(activity.FromCollectiveId);
        }
      },
    },
    account: {
      type: Account,
      description: 'The account targeted by this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.CollectiveId) {
          return req.loaders.Collective.byId.load(activity.CollectiveId);
        }
      },
    },
    host: {
      type: Host,
      description: 'The host under which this activity happened, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.HostCollectiveId) {
          return req.loaders.Collective.byId.load(activity.HostCollectiveId);
        }
      },
    },
    individual: {
      type: Individual,
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
      type: Expense,
      description: 'The expense related to this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.ExpenseId) {
          return req.loaders.Expense.byId.load(activity.ExpenseId);
        }
      },
    },
    order: {
      type: Order,
      description: 'The order related to this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.OrderId) {
          return req.loaders.Order.byId.load(activity.OrderId);
        }
      },
    },
    transaction: {
      type: Transaction,
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
        } else if (activity.type === ACTIVITY.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE) {
          if (activity.ExpenseId) {
            const expense = await req.loaders.Expense.byId.load(activity.ExpenseId);
            if (await ExpenseLib.canSeeExpenseInvoiceInfo(req, expense)) {
              toPick.push('message');
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
        } else if (activity.type === ACTIVITY.COLLECTIVE_EDITED) {
          const collective = await req.loaders.Collective.byId.load(activity.CollectiveId);
          if (req.remoteUser?.isAdminOfCollectiveOrHost(collective)) {
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
