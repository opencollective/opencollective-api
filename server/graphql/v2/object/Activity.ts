import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-type-json';
import { pick } from 'lodash';

import ACTIVITY from '../../../constants/activities';
import * as ExpenseLib from '../../common/expenses';
import { ActivityType } from '../enum';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

import { Individual } from './Individual';

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
    account: {
      type: Account,
      description: 'The account concerned by this activity, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.CollectiveId) {
          return req.loaders.Collective.byId.load(activity.CollectiveId);
        }
      },
    },
    individual: {
      type: Individual,
      description: 'The person who triggered the action, if any',
      resolve: async (activity, _, req: express.Request): Promise<Record<string, unknown>> => {
        if (activity.UserId) {
          const collective = await req.loaders.Collective.byUserId.load(activity.UserId);
          if (!collective?.isIncognito) {
            return collective;
          }
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
        }

        return pick(activity.data, toPick);
      },
    },
  }),
});
