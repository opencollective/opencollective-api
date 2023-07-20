import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSONObject } from 'graphql-scalars';

import ExpenseStatus from '../../../constants/expense_status.js';
import { VirtualCardLimitIntervals } from '../../../constants/virtual-cards.js';
import { getSpendingLimitIntervalDates } from '../../../lib/stripe.js';
import models, { Op, VirtualCard } from '../../../models/index.js';
import { checkScope } from '../../common/scope-check.js';
import { GraphQLCurrency } from '../enum/index.js';
import { GraphQLVirtualCardLimitInterval } from '../enum/VirtualCardLimitInterval.js';
import { GraphQLVirtualCardStatusEnum } from '../enum/VirtualCardStatus.js';
import { GraphQLAccount } from '../interface/Account.js';

import { GraphQLHost } from './Host.js';
import { GraphQLIndividual } from './Individual.js';
import { GraphQLVirtualCardRequest } from './VirtualCardRequest.js';

const canSeeVirtualCardPrivateInfo = (req, collective) =>
  req.remoteUser?.isAdminOfCollectiveOrHost(collective) && checkScope(req, 'virtualCards');

export const GraphQLVirtualCard = new GraphQLObjectType({
  name: 'VirtualCard',
  description: 'A Virtual Card used to pay expenses',
  fields: () => ({
    id: { type: GraphQLString },
    account: {
      type: GraphQLAccount,
      resolve(virtualCard, _, req) {
        if (virtualCard.CollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        }
      },
    },
    host: {
      type: GraphQLHost,
      resolve(virtualCard, _, req) {
        if (virtualCard.HostCollectiveId) {
          return req.loaders.Collective.byId.load(virtualCard.HostCollectiveId);
        }
      },
    },
    assignee: {
      type: GraphQLIndividual,
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
    status: {
      type: GraphQLVirtualCardStatusEnum,
      async resolve(virtualCard, _, req) {
        const collective = await req.loaders.Collective.byId.load(virtualCard.CollectiveId);
        if (canSeeVirtualCardPrivateInfo(req, collective)) {
          return virtualCard.data.status;
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
      type: GraphQLVirtualCardLimitInterval,
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
    currency: { type: GraphQLCurrency },
    virtualCardRequest: {
      type: GraphQLVirtualCardRequest,
      resolve(virtualCard: VirtualCard, _: void, req: Express.Request) {
        if (!virtualCard.VirtualCardRequestId) {
          return null;
        }
        return req.loaders.VirtualCardRequest.byId.load(virtualCard.VirtualCardRequestId);
      },
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
