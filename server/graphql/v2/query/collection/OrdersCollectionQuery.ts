import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { Includeable, Order } from 'sequelize';

import { buildSearchConditions } from '../../../../lib/search';
import models, { Op } from '../../../../models';
import { checkScope } from '../../../common/scope-check';
import { NotFound, Unauthorized } from '../../../errors';
import { GraphQLOrderCollection } from '../../collection/OrderCollection';
import { GraphQLAccountOrdersFilter } from '../../enum/AccountOrdersFilter';
import { GraphQLContributionFrequency } from '../../enum/ContributionFrequency';
import { GraphQLOrderStatus } from '../../enum/OrderStatus';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import {
  fetchPaymentMethodWithReference,
  GraphQLPaymentMethodReferenceInput,
} from '../../input/PaymentMethodReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

type OrderAssociation = 'fromCollective' | 'collective';

// Returns the join condition for association
const getJoinCondition = (
  account,
  association: OrderAssociation,
  includeHostedAccounts = false,
): Record<string, unknown> => {
  const associationFields = { collective: 'CollectiveId', fromCollective: 'FromCollectiveId' };
  const field = associationFields[association] || `$${association}.id$`;

  if (!includeHostedAccounts || !account.isHostAccount) {
    return { [field]: account.id };
  } else {
    return {
      [Op.or]: [
        {
          [field]: account.id,
        },
        {
          [`$${association}.HostCollectiveId$`]: account.id,
          [`$${association}.approvedAt$`]: { [Op.not]: null },
        },
      ],
    };
  }
};

export const OrdersCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  includeHostedAccounts: {
    type: GraphQLBoolean,
    description: 'If account is a host, also include hosted accounts orders',
  },
  paymentMethod: {
    type: GraphQLPaymentMethodReferenceInput,
    description:
      'Only return orders that were paid with this payment method. Must be an admin of the account owning the payment method.',
  },
  includeIncognito: {
    type: GraphQLBoolean,
    description: 'Whether to include incognito orders. Must be admin or root. Only with filter null or OUTGOING.',
    defaultValue: false,
  },
  filter: {
    type: GraphQLAccountOrdersFilter,
    description: 'Account orders filter (INCOMING or OUTGOING)',
  },
  frequency: {
    type: GraphQLContributionFrequency,
    description: 'Use this field to filter orders on their frequency (ONETIME, MONTHLY or YEARLY)',
  },
  status: {
    type: new GraphQLList(GraphQLOrderStatus),
    description: 'Use this field to filter orders on their statuses',
  },
  orderBy: {
    type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
    description: 'The order of results',
    defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  },
  minAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is greater than or equal to this value (in cents)',
  },
  maxAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is lower than or equal to this value (in cents)',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created before this date',
  },
  searchTerm: {
    type: GraphQLString,
    description: 'The term to search',
  },
  tierSlug: {
    type: GraphQLString,
    deprecationReason: '2022-02-25: Should be replaced by a tier reference. Not existing yet.',
  },
  onlySubscriptions: {
    type: GraphQLBoolean,
    description: `Only returns orders that have a subscription (monthly/yearly). Don't use together with frequency.`,
  },
  onlyActiveSubscriptions: {
    type: GraphQLBoolean,
    description: `Same as onlySubscriptions, but returns only orders with active subscriptions`,
  },
};

export const OrdersCollectionResolver = async (args, req: express.Request) => {
  const where = { [Op.and]: [] };
  const include: Includeable[] = [
    { association: 'fromCollective', required: true, attributes: [] },
    { association: 'collective', required: true, attributes: [] },
  ];

  // Check Pagination arguments
  if (args.limit <= 0) {
    args.limit = 100;
  }
  if (args.offset <= 0) {
    args.offset = 0;
  }
  if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
    throw new Error('Cannot fetch more than 1,000 orders at the same time, please adjust the limit');
  }

  let account;

  // Load accounts
  if (args.account) {
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    account = await fetchAccountWithReference(args.account, fetchAccountParams);

    const accountConditions = [];

    // Filter on fromCollective
    if (!args.filter || args.filter === 'OUTGOING') {
      accountConditions.push(getJoinCondition(account, 'fromCollective', args.includeHostedAccounts));
      if (args.includeIncognito) {
        // Needs to be root or admin of the profile to see incognito orders
        if (
          (req.remoteUser?.isAdminOfCollective(account) && checkScope(req, 'incognito')) ||
          (req.remoteUser?.isRoot() && checkScope(req, 'root'))
        ) {
          const incognitoProfile = await account.getIncognitoProfile();
          if (incognitoProfile) {
            accountConditions.push(getJoinCondition(incognitoProfile, 'fromCollective'));
          }
        } else {
          // Is this desirable? Some current tests don't like it.
          // throw new Error('Only admins and root can fetch incognito orders');
        }
      }
    }

    // Filter on collective
    if (!args.filter || args.filter === 'INCOMING') {
      accountConditions.push(getJoinCondition(account, 'collective', args.includeHostedAccounts));
    }

    // Bind account conditions to the query
    where[Op.and].push(accountConditions.length === 1 ? accountConditions : { [Op.or]: accountConditions });
  }

  // Load payment method
  if (args.paymentMethod) {
    const paymentMethod = await fetchPaymentMethodWithReference(args.paymentMethod, {
      sequelizeOpts: { attributes: ['id'], include: [{ model: models.Collective }] },
    });
    if (!req.remoteUser?.isAdminOfCollective(paymentMethod.Collective)) {
      throw new Unauthorized('You must be an admin of the payment method to fetch its orders');
    }
    where['PaymentMethodId'] = paymentMethod.id;
  }

  // Add search filter
  const searchTermConditions = buildSearchConditions(args.searchTerm, {
    idFields: ['id'],
    slugFields: ['$fromCollective.slug$', '$collective.slug$'],
    textFields: [
      '$fromCollective.name$',
      '$collective.name$',
      'description',
      'data.ponumber',
      'data.fromAccountInfo.name',
      'data.fromAccountInfo.email',
    ],
    amountFields: ['totalAmount'],
    stringArrayFields: ['tags'],
    stringArrayTransformFn: (str: string) => str.toLowerCase(), // expense tags are stored lowercase
  });

  if (searchTermConditions.length) {
    where[Op.and].push({ [Op.or]: searchTermConditions });
  }

  // Add filters
  if (args.minAmount) {
    where['totalAmount'] = { [Op.gte]: args.minAmount };
  }
  if (args.maxAmount) {
    where['totalAmount'] = { ...where['totalAmount'], [Op.lte]: args.maxAmount };
  }
  if (args.dateFrom) {
    where['createdAt'] = { [Op.gte]: args.dateFrom };
  }
  if (args.dateTo) {
    where['createdAt'] = where['createdAt'] || {};
    where['createdAt'][Op.lte] = args.dateTo;
  }
  if (args.status && args.status.length > 0) {
    where['status'] = { [Op.in]: args.status };
  }

  if (args.frequency) {
    if (args.frequency === 'ONETIME') {
      where['SubscriptionId'] = { [Op.is]: null };
    } else if (args.frequency === 'MONTHLY') {
      include.push({ model: models.Subscription, required: true, where: { interval: 'month' } });
    } else if (args.frequency === 'YEARLY') {
      include.push({ model: models.Subscription, required: true, where: { interval: 'year' } });
    }
  } else if (args.onlySubscriptions) {
    include.push({ model: models.Subscription, required: false });
    where[Op.and].push({
      [Op.or]: [
        { ['$Subscription.id$']: { [Op.ne]: null } },
        { interval: { [Op.in]: ['year', 'month'] }, status: 'PROCESSING' },
      ],
    });
  } else if (args.onlyActiveSubscriptions) {
    include.push({ model: models.Subscription, required: true, where: { isActive: true } });
  }

  if (args.tierSlug) {
    if (!account) {
      throw new NotFound('tierSlug can only be used when an account is specified');
    }
    const tierSlug = args.tierSlug.toLowerCase();
    const tier = await models.Tier.findOne({ where: { CollectiveId: account.id, slug: tierSlug } });
    if (!tier) {
      throw new NotFound('tierSlug Not Found');
    }
    where['TierId'] = tier.id;
  }

  const order: Order = [[args.orderBy.field, args.orderBy.direction]];
  const { offset, limit } = args;
  const result = await models.Order.findAndCountAll({ include, where, order, offset, limit });
  return {
    nodes: result.rows,
    totalCount: result.count,
    limit: args.limit,
    offset: args.offset,
  };
};

// Using a generator to avoid circular dependencies (OrderCollection -> Order -> PaymentMethod -> OrderCollection -> ...)
const getOrdersCollectionQuery = () => ({
  type: new GraphQLNonNull(GraphQLOrderCollection),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Return only orders made from/to account',
    },
    ...OrdersCollectionArgs,
  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    return OrdersCollectionResolver(args, req);
  },
});

export default getOrdersCollectionQuery;
