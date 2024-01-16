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
import { pick, round } from 'lodash';

import roles from '../../../constants/roles';
import { getHostFeePercent } from '../../../lib/payments';
import models from '../../../models';
import { CommentType } from '../../../models/Comment';
import { PRIVATE_ORDER_ACTIVITIES } from '../../loaders/order';
import { GraphQLActivityCollection } from '../collection/ActivityCollection';
import { CommentCollection } from '../collection/CommentCollection';
import { GraphQLContributionFrequency, GraphQLOrderStatus } from '../enum';
import { idEncode } from '../identifiers';
import { GraphQLChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { GraphQLAccount } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';
import { GraphQLTransaction } from '../interface/Transaction';
import { GraphQLAmount } from '../object/Amount';
import { GraphQLPaymentMethod } from '../object/PaymentMethod';
import { GraphQLTier } from '../object/Tier';

import GraphQLAccountingCategory from './AccountingCategory';
import { GraphQLMemberOf } from './Member';
import GraphQLOrderPermissions, { canComment, canSeeOrderPrivateActivities } from './OrderPermissions';
import { GraphQLOrderTax } from './OrderTax';
import { GraphQLTaxInfo } from './TaxInfo';

const GraphQLPendingOrderFromAccountInfo = new GraphQLObjectType({
  name: 'PendingOrderFromAccountInfo',
  fields: () => ({
    name: {
      type: GraphQLString,
    },
    email: {
      type: GraphQLString,
    },
  }),
});

const GraphQLPendingOrderData = new GraphQLObjectType({
  name: 'PendingOrderData',
  fields: () => ({
    expectedAt: {
      type: GraphQLDateTime,
    },
    paymentMethod: {
      type: GraphQLString,
    },
    ponumber: {
      type: GraphQLString,
    },
    memo: {
      type: GraphQLString,
    },
    fromAccountInfo: {
      type: GraphQLPendingOrderFromAccountInfo,
    },
  }),
});

export const GraphQLOrder = new GraphQLObjectType({
  name: 'Order',
  description: 'Order model',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve(order) {
          return idEncode(order.id, 'order');
        },
      },
      legacyId: {
        type: new GraphQLNonNull(GraphQLInt),
        resolve(order) {
          return order.id;
        },
      },
      description: {
        type: GraphQLString,
        resolve(order) {
          return order.description;
        },
      },
      amount: {
        type: new GraphQLNonNull(GraphQLAmount),
        description: 'Base order amount (without platform tip)',
        resolve(order) {
          // We remove Platform Tip from totalAmount
          const value = order.totalAmount - order.platformTipAmount;
          return { value, currency: order.currency };
        },
      },
      taxAmount: {
        type: GraphQLAmount,
        description: 'Tax amount',
        resolve(order) {
          if (order.taxAmount) {
            return { value: order.taxAmount, currency: order.currency };
          }
        },
      },
      totalAmount: {
        type: new GraphQLNonNull(GraphQLAmount),
        description: 'Total order amount, including all taxes and platform tip',
        resolve(order) {
          return { value: order.totalAmount, currency: order.currency };
        },
      },
      quantity: {
        type: GraphQLInt,
      },
      status: {
        type: GraphQLOrderStatus,
        resolve(order) {
          return order.status;
        },
      },
      frequency: {
        type: GraphQLContributionFrequency,
        async resolve(order, _, req) {
          const subscription = order.SubscriptionId && (await req.loaders.Subscription.byId.load(order.SubscriptionId));
          if (!subscription) {
            return 'ONETIME';
          }
          if (subscription.interval === 'month') {
            return 'MONTHLY';
          } else if (subscription.interval === 'year') {
            return 'YEARLY';
          }
        },
      },
      nextChargeDate: {
        type: GraphQLDateTime,
        async resolve(order, _, req) {
          const subscription = order.SubscriptionId && (await req.loaders.Subscription.byId.load(order.SubscriptionId));
          return subscription?.nextChargeDate;
        },
      },
      tier: {
        type: GraphQLTier,
        resolve(order, args, req) {
          if (order.tier) {
            return order.tier;
          }
          if (order.TierId) {
            return req.loaders.Tier.byId.load(order.TierId);
          }
        },
      },
      fromAccount: {
        type: GraphQLAccount,
        resolve(order, _, req) {
          return req.loaders.Collective.byId.load(order.FromCollectiveId);
        },
      },
      toAccount: {
        type: GraphQLAccount,
        resolve(order, _, req) {
          return req.loaders.Collective.byId.load(order.CollectiveId);
        },
      },
      transactions: {
        description: 'Transactions for this order ordered by createdAt ASC',
        type: new GraphQLNonNull(new GraphQLList(GraphQLTransaction)),
        resolve(order, _, req) {
          return req.loaders.Transaction.byOrderId.load(order.id);
        },
      },
      createdAt: {
        type: GraphQLDateTime,
        resolve(order) {
          return order.createdAt;
        },
      },
      updatedAt: {
        type: GraphQLDateTime,
        resolve(order) {
          return order.updatedAt;
        },
      },
      totalDonations: {
        type: new GraphQLNonNull(GraphQLAmount),
        description:
          'WARNING: Total amount donated between collectives, though there will be edge cases especially when looking on the Order level, as the order id is not used in calculating this.',
        async resolve(order, args, req) {
          const value = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
            FromCollectiveId: order.FromCollectiveId,
            CollectiveId: order.CollectiveId,
          });
          return { value, currency: order.currency };
        },
      },
      paymentMethod: {
        type: GraphQLPaymentMethod,
        resolve(order, _, req) {
          if (order.PaymentMethodId) {
            return req.loaders.PaymentMethod.byId.load(order.PaymentMethodId);
          }
        },
      },
      hostFeePercent: {
        type: GraphQLFloat,
        description: 'Host fee percent attached to the Order.',
        async resolve(order, _, req) {
          return await getHostFeePercent(order, { loaders: req.loaders });
        },
      },
      platformTipAmount: {
        type: GraphQLAmount,
        description: 'Platform Tip attached to the Order.',
        resolve(order) {
          return { value: order.platformTipAmount, currency: order.currency };
        },
      },
      platformTipEligible: {
        type: GraphQLBoolean,
      },
      tags: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
        resolve(order) {
          return order.tags || [];
        },
      },
      tax: {
        type: GraphQLTaxInfo,
        resolve(order) {
          if (order.data?.tax) {
            return {
              id: order.data.tax.id,
              type: order.data.tax.id,
              percentage: order.data.tax.percentage,
              rate: round(order.data.tax.percentage / 100, 2),
              idNumber: order.data.tax.idNumber,
            };
          }
        },
      },
      taxes: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLOrderTax)),
        deprecationReason: '2023-04-13: Please use `tax` instead.',
        resolve(order) {
          if (order.data?.tax) {
            return [
              {
                type: order.data.tax.id,
                percentage: order.data.tax.percentage,
              },
            ];
          } else {
            return [];
          }
        },
      },
      membership: {
        type: GraphQLMemberOf,
        description:
          'This represents a MemberOf relationship (ie: Collective backed by an Individual) attached to the Order.',
        async resolve(order) {
          return models.Member.findOne({
            where: {
              MemberCollectiveId: order.FromCollectiveId,
              CollectiveId: order.CollectiveId,
              role: roles.BACKER,
              TierId: order.TierId,
            },
          });
        },
      },
      permissions: {
        type: new GraphQLNonNull(GraphQLOrderPermissions),
        description: 'The permissions given to current logged in user for this order',
        async resolve(order) {
          return order; // Individual fields are set by OrderPermissions resolvers
        },
      },
      accountingCategory: {
        type: GraphQLAccountingCategory,
        description: 'The accounting category attached to this order',
        async resolve(order, _, req) {
          if (order.AccountingCategoryId) {
            return req.loaders.AccountingCategory.byId.load(order.AccountingCategoryId);
          }
        },
      },
      activities: {
        // We're not paginating yet, but already using the collection type to introduce it without breaking changes in the future
        type: new GraphQLNonNull(GraphQLActivityCollection),
        description: 'The list of activities (ie. approved, edited, etc) for this Order ordered by date ascending',
        async resolve(order, _, req) {
          let activities = await req.loaders.Order.activities.load(order.id);
          if (!(await canSeeOrderPrivateActivities(req, order))) {
            activities = activities.filter(activity => !PRIVATE_ORDER_ACTIVITIES.includes(activity.type));
          }

          return {
            nodes: activities,
            totalCount: activities.length,
            limit: activities.length,
            offset: 0,
          };
        },
      },
      data: {
        type: GraphQLJSON,
        description: 'Data related to the order',
        resolve(order) {
          // There used to be some public values allowed (thegivingblock, ORDER_PUBLIC_DATA_FIELDS), but not anymore
          return pick(order.data, []);
        },
      },
      customData: {
        type: GraphQLJSON,
        description:
          'Custom data related to the order, based on the fields described by tier.customFields. Must be authenticated as an admin of the fromAccount or toAccount (returns null otherwise)',
        async resolve(order, _, { remoteUser, loaders }) {
          const [fromCollective, collective] = await Promise.all([
            loaders.Collective.byId.load(order.FromCollectiveId),
            loaders.Collective.byId.load(order.CollectiveId),
          ]);

          if (
            !remoteUser ||
            !(remoteUser.isAdminOfCollective(collective) || remoteUser.isAdminOfCollective(fromCollective))
          ) {
            return null;
          } else {
            return order.data?.customData || {};
          }
        },
      },
      memo: {
        type: GraphQLString,
        description:
          'Memo field which adds additional details about the order. For example in added funds this can be a note to mark what method (cheque, money order) the funds were received.',
        async resolve(order, _, { loaders, remoteUser }) {
          const collective = order.collective || (await loaders.Collective.byId.load(order.CollectiveId));
          const hostCollectiveId = collective?.HostCollectiveId;
          if (remoteUser && remoteUser.hasRole([roles.ACCOUNTANT, roles.ADMIN], hostCollectiveId)) {
            return order.data?.memo;
          } else {
            return null;
          }
        },
      },
      createdByAccount: {
        type: GraphQLAccount,
        description: 'The account who created this order',
        async resolve(order, _, req) {
          if (!order.CreatedByUserId) {
            return null;
          }

          const user = await req.loaders.User.byId.load(order.CreatedByUserId);
          if (user && user.CollectiveId) {
            const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
            if (collective && !collective.isIncognito) {
              return collective;
            }
          }
        },
      },
      processedAt: {
        type: GraphQLDateTime,
        description: 'Date the funds were received.',
        async resolve(order) {
          return order?.processedAt;
        },
      },
      pendingContributionData: {
        type: GraphQLPendingOrderData,
        description: 'Data about the pending contribution',
        async resolve(order, _, req) {
          const pendingContributionFields = ['expectedAt', 'paymentMethod', 'ponumber', 'fromAccountInfo', 'memo'];
          const fromCollective = await req.loaders.Collective.byId.load(order.FromCollectiveId);
          const collective = await req.loaders.Collective.byId.load(order.CollectiveId);
          if (
            req.remoteUser?.isAdminOfCollectiveOrHost(fromCollective) ||
            req.remoteUser?.isAdminOfCollectiveOrHost(collective)
          ) {
            return pick(order.data, pendingContributionFields);
          }
          return null;
        },
      },
      needsConfirmation: {
        type: GraphQLBoolean,
        description: 'Whether the order needs confirmation (3DSecure/SCA)',
        async resolve(order, _, req) {
          order.fromCollective =
            order.fromCollective || (await req.loaders.Collective.byId.load(order.FromCollectiveId));
          if (!req.remoteUser?.isAdminOfCollective(order.fromCollective)) {
            return null;
          }
          return Boolean(
            ['REQUIRE_CLIENT_CONFIRMATION', 'ERROR', 'PENDING'].includes(order.status) && order.data?.needsConfirmation,
          );
        },
      },
      comments: {
        type: CommentCollection,
        description: 'Returns the list of comments for this order, or `null` if user is not allowed to see them',
        args: {
          ...CollectionArgs,
          orderBy: {
            type: GraphQLChronologicalOrderInput,
            defaultValue: { field: 'createdAt', direction: 'ASC' },
          },
        },
        async resolve(order, { limit, offset, orderBy }, req) {
          if (!(await canComment(req, order))) {
            return null;
          }

          const type = [CommentType.PRIVATE_NOTE];

          const { rows: nodes, count: totalCount } = await models.Comment.findAndCountAll({
            where: { OrderId: order.id, type },
            order: [[orderBy.field, orderBy.direction]],
            offset,
            limit,
          });

          return {
            offset,
            limit,
            totalCount,
            nodes,
          };
        },
      },
    };
  },
});
