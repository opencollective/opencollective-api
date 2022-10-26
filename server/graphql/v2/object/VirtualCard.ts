import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSONObject } from 'graphql-type-json';

import ExpenseStatus from '../../../constants/expense_status';
import { VirtualCardLimitIntervals } from '../../../constants/virtual-cards';
import { getSpendingLimitIntervalDates } from '../../../lib/stripe';
import models, { Op } from '../../../models';
import { checkScope } from '../../common/scope-check';
import { Currency } from '../enum';
import { VirtualCardLimitInterval } from '../enum/VirtualCardLimitInterval';
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
      type: VirtualCardLimitInterval,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.spendingLimitInterval;
        }
      },
    },
    spendingLimitRenewsOn: {
      type: GraphQLDateTime,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          const { spendingLimitInterval } = virtualCard;

          const { renewsOn } = getSpendingLimitIntervalDates(spendingLimitInterval);

          return renewsOn;
        }
      },
    },
    remainingLimit: {
      type: GraphQLInt,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          const { spendingLimitAmount, spendingLimitInterval } = virtualCard;

          if (spendingLimitInterval === VirtualCardLimitIntervals.PER_AUTHORIZATION) {
            return spendingLimitAmount;
          }

          const { renewedOn } = getSpendingLimitIntervalDates(spendingLimitInterval);

          const sumExpensesInPeriod = await models.Expense.sum('amount', {
            where: {
              VirtualCardId: virtualCard.id,
              status: [ExpenseStatus.PROCESSING, ExpenseStatus.PAID],
              ...(renewedOn && { incurredAt: { [Op.gte]: renewedOn } }),
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
