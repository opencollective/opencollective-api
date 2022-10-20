import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSONObject } from 'graphql-type-json';
import moment from 'moment';

import models, { Op } from '../../../models';
import { checkScope } from '../../common/scope-check';
import { Currency } from '../enum';
import { Account } from '../interface/Account';

import { Individual } from './Individual';

const canSeeVirtualCardPrivateInfo = (req, collective) =>
  req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards');

export const VirtualCard = new GraphQLObjectType({
  name: 'VirtualCard',
  description: 'A Virtual Card used to pay expenses',
  fields: () => ({
    id: { type: GraphQLString },
    account: {
      type: Account,
      resolve(virtualCard, _, req) {
        if (virtualCard.CollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        }
      },
    },
    host: {
      type: Account,
      resolve(virtualCard, _, req) {
        if (virtualCard.HostCollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.HostCollectiveId);
        }
      },
    },
    assignee: {
      type: Individual,
      async resolve(virtualCard, _, req) {
        if (!virtualCard.UserId) {
          return null;
        }

        const user = await req.loaders.User.byId.load(virtualCard.UserId);
        if (user && user.CollectiveId) {
          const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
          if (collective && !collective.isIncognito) {
            return collective;
          }
        }
      },
    },
    name: {
      type: GraphQLString,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.name;
        }
      },
    },
    last4: {
      type: GraphQLString,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.last4;
        }
      },
    },
    data: {
      type: GraphQLJSONObject,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.data;
        }
      },
    },
    privateData: {
      type: GraphQLJSONObject,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.get('privateData');
        }
      },
    },
    provider: { type: GraphQLString },
    spendingLimitAmount: {
      type: GraphQLInt,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.spendingLimitAmount;
        }
      },
    },
    spendingLimitInterval: {
      type: GraphQLString,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.spendingLimitInterval;
        }
      },
    },
    remainingLimit: {
      type: GraphQLInt,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          const { spendingLimitAmount, spendingLimitInterval } = virtualCard;
          let startOfInterval: string;

          // Stripe spending limit intervals start on UTC midnight for daily, Sunday at midnight UTC for weekly and 1st of the month or year
          // https://stripe.com/docs/api/issuing/cards/object#issuing_card_object-spending_controls-spending_limits-interval
          switch (spendingLimitInterval) {
            case 'DAILY':
              startOfInterval = moment().utc(true).startOf('day').toISOString();
              break;
            case 'WEEKLY':
              startOfInterval = moment().utc(true).startOf('isoWeek').toISOString();
              break;
            case 'MONTHLY':
              startOfInterval = moment().utc(true).startOf('month').toISOString();
              break;
            case 'ANNUALLY':
              startOfInterval = moment().utc(true).startOf('year').toISOString();
              break;
            case 'FOREVER':
              startOfInterval = undefined;
              break;
            case 'TRANSACTION':
              return spendingLimitAmount;
            default:
              return null;
          }

          const sumExpensesInPeriod = await models.Expense.sum('amount', {
            where: {
              VirtualCardId: virtualCard.id,
              ...(startOfInterval && { incurredAt: { [Op.gte]: startOfInterval } }),
            },
          });

          return spendingLimitAmount - sumExpensesInPeriod;
        }
      },
    },
    currency: { type: Currency },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
