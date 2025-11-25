import assert from 'assert';

import express from 'express';
import { GraphQLBoolean, GraphQLEnumType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact, isNil, uniq } from 'lodash';
import { Includeable, Order, Utils as SequelizeUtils, WhereOptions } from 'sequelize';

import OrderStatuses from '../../../../constants/order-status';
import { buildSearchConditions } from '../../../../lib/sql-search';
import models, { Collective, Op, sequelize } from '../../../../models';
import { checkScope } from '../../../common/scope-check';
import { Forbidden, NotFound, Unauthorized } from '../../../errors';
import { GraphQLOrderCollection } from '../../collection/OrderCollection';
import { GraphQLAccountOrdersFilter } from '../../enum/AccountOrdersFilter';
import { GraphQLContributionFrequency } from '../../enum/ContributionFrequency';
import GraphQLHostContext from '../../enum/HostContext';
import { GraphQLOrderPausedBy } from '../../enum/OrderPausedBy';
import { GraphQLOrderStatus } from '../../enum/OrderStatus';
import { GraphQLPaymentMethodService } from '../../enum/PaymentMethodService';
import { GraphQLPaymentMethodType } from '../../enum/PaymentMethodType';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../../input/AmountInput';
import { GraphQLAmountRangeInput } from '../../input/AmountRangeInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import {
  fetchPaymentMethodWithReferences,
  GraphQLPaymentMethodReferenceInput,
} from '../../input/PaymentMethodReferenceInput';
import { getDatabaseIdFromTierReference, GraphQLTierReferenceInput } from '../../input/TierReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

type OrderAssociation = 'fromCollective' | 'collective';

// Returns the join condition for association
const getCollectivesJoinCondition = (
  account,
  association: OrderAssociation,
  includeChildrenAccounts = false,
  hostContext?: 'ALL' | 'INTERNAL' | 'HOSTED', // TODO: make this a constant
  limitToHostedAccounts?: Collective[],
): WhereOptions => {
  const associationFields = { collective: 'CollectiveId', fromCollective: 'FromCollectiveId' };
  const field =
    // Foreign Key columns should only be used in isolation. When querying for associated data, it is more performant to also query for the associated id
    associationFields[association] && !includeChildrenAccounts && !(hostContext && account.isHostAccount)
      ? associationFields[association]
      : `$${association}.id$`;
  const limitToHostedAccountsIds = limitToHostedAccounts?.map(a => a.id).filter(id => id !== account.id) || [];
  const allTopAccountIds = uniq([account.id, ...limitToHostedAccountsIds]);
  let conditions = [{ [field]: allTopAccountIds }];
  let shouldQueryForChildAccounts = includeChildrenAccounts;

  if (hostContext && account.isHostAccount) {
    // Skip specifically querying for children when using host context unless you specify specific account ids, since all children collectives also have the HostCollectiveId
    if (!limitToHostedAccountsIds.length) {
      shouldQueryForChildAccounts = false;
    }

    // Hosted accounts are always approved and have a HostCollectiveId
    const hostedAccountCondition: WhereOptions = {
      [`$${association}.HostCollectiveId$`]: account.id,
      [`$${association}.approvedAt$`]: { [Op.not]: null },
    };

    // Handle id filtering: either limit to specific hosted accounts, or exclude host accounts
    if (limitToHostedAccountsIds.length) {
      conditions = [{ ...hostedAccountCondition, [`$${association}.id$`]: { [Op.in]: limitToHostedAccountsIds } }];
    } else if (hostContext === 'ALL') {
      conditions = [hostedAccountCondition];
    } else if (hostContext === 'HOSTED') {
      // Exclude the host account and its children
      conditions = [
        {
          ...hostedAccountCondition,
          [`$${association}.id$`]: { [Op.ne]: account.id },
          [`$${association}.ParentCollectiveId$`]: {
            [Op.or]: [{ [Op.is]: null }, { [Op.ne]: account.id }],
          },
        },
      ];
    } else if (hostContext === 'INTERNAL') {
      // Only get internal accounts
      conditions = [
        {
          [Op.or]: [{ [`$${association}.id$`]: account.id }, { [`$${association}.ParentCollectiveId$`]: account.id }],
        },
      ];
    }
  }

  if (shouldQueryForChildAccounts) {
    if (limitToHostedAccountsIds.length) {
      conditions.push({ [`$${association}.ParentCollectiveId$`]: limitToHostedAccountsIds });
    } else {
      conditions.push({ [`$${association}.ParentCollectiveId$`]: allTopAccountIds });
    }
  }

  return conditions.length === 1 ? conditions[0] : { [Op.or]: conditions };
};

export const OrdersCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  includeHostedAccounts: {
    type: GraphQLBoolean,
    description: 'If account is a host, also include hosted accounts orders',
    deprecationReason: '2025-11-20: Please use hostContext instead',
  },
  hostContext: {
    type: GraphQLHostContext,
    description:
      'If account is a host, select whether to include ALL, INTERNAL or HOSTED accounts. When set (and `hostedAccounts` is not provided), this will automatically include children accounts (events/projects) of the selected accounts. If `hostedAccounts` is also provided, use `includeChildrenAccounts` to control children account inclusion.',
  },
  includeChildrenAccounts: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      'Include orders from children events/projects. Only relevant when `hostedAccounts` is provided. When `hostContext` is set without `hostedAccounts`, children accounts are automatically included regardless of this parameter.',
    defaultValue: false,
  },
  pausedBy: {
    type: new GraphQLList(GraphQLOrderPausedBy),
    description: 'Only return orders that were paused by these roles. status must be set to PAUSED.',
  },
  paymentMethod: {
    type: new GraphQLList(GraphQLPaymentMethodReferenceInput),
    description:
      'Only return orders that were paid with this payment method. Must be an admin of the account owning the payment method.',
  },
  paymentMethodService: {
    type: new GraphQLList(GraphQLPaymentMethodService),
    description: 'Only return orders that match these payment method services',
  },
  paymentMethodType: {
    type: new GraphQLList(GraphQLPaymentMethodType),
    description: 'Only return orders that match these payment method types',
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
    type: new GraphQLList(GraphQLContributionFrequency),
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
  amount: {
    type: GraphQLAmountRangeInput,
    description: 'Only return expenses that match this amount range',
  },
  minAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is greater than or equal to this value (in cents)',
    deprecate: '2025-05-26: Please use amount instead',
  },
  maxAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is lower than or equal to this value (in cents)',
    deprecate: '2025-05-26: Please use amount instead',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created before this date',
  },
  expectedDateFrom: {
    type: GraphQLDateTime,
    description: 'Only return pending orders that were expected after this date',
  },
  expectedDateTo: {
    type: GraphQLDateTime,
    description: 'Only return pending orders that were expected before this date',
  },
  chargedDateFrom: {
    type: GraphQLDateTime,
    description: 'Return orders that were charged after this date',
  },
  chargedDateTo: {
    type: GraphQLDateTime,
    description: 'Return orders that were charged before this date',
  },
  searchTerm: {
    type: GraphQLString,
    description: 'The term to search',
  },
  tierSlug: {
    type: GraphQLString,
    deprecationReason: '2022-02-25: Should be replaced by a tier reference.',
  },
  tier: {
    type: new GraphQLList(GraphQLTierReferenceInput),
  },
  onlySubscriptions: {
    type: GraphQLBoolean,
    description: `Only returns orders that have a subscription (monthly/yearly). Don't use together with frequency.`,
  },
  onlyActiveSubscriptions: {
    type: GraphQLBoolean,
    description: `Same as onlySubscriptions, but returns only orders with active subscriptions`,
  },
  expectedFundsFilter: {
    type: new GraphQLEnumType({
      name: 'ExpectedFundsFilter',
      description: 'Expected funds filter (ALL_EXPECTED_FUNDS, ONLY_PENDING, ONLY_MANUAL)',
      values: {
        ALL_EXPECTED_FUNDS: {},
        ONLY_PENDING: {},
        ONLY_MANUAL: {},
      },
    }),
  },
  oppositeAccount: {
    type: GraphQLAccountReferenceInput,
    description:
      'Return only orders made from/to that opposite account (only works when orders are already filtered with a main account)',
  },
  hostedAccounts: {
    type: new GraphQLList(GraphQLAccountReferenceInput),
    description: 'Return only orders made from/to these hosted accounts',
  },
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'Return orders only for this host',
  },
};

export const OrdersCollectionResolver = async (args, req: express.Request) => {
  const where = { [Op.and]: [] };
  const include: Includeable[] = [
    { association: 'fromCollective', required: true, attributes: [] },
    { association: 'collective', required: true, attributes: [] },
    { model: models.Subscription, required: false, attributes: [] },
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

  const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
  const host = args.host && (await fetchAccountWithReference(args.host, fetchAccountParams));
  let account, oppositeAccount, hostedAccounts, includeHostedAccounts, hostContext;

  // // Override with deprecated includeHostedAccounts argument
  if (args.includeHostedAccounts === true && isNil(args.hostContext)) {
    hostContext = 'ALL';
  } else {
    hostContext = args.hostContext;
  }

  // let includeChildrenAccounts = args.includeChildrenAccounts;

  // Skip including children if `hostContext` is set without `hostedAccounts`
  // It will not change the result (as all children accounts are also hosted) and only increase query complexity
  // if (!isNil(args.hostContext) && isNil(args.hostedAccounts)) {
  //   includeChildrenAccounts = true;
  // }

  // Load accounts
  if (args.account) {
    account = await fetchAccountWithReference(args.account, fetchAccountParams);

    // Load opposite account
    if (args.oppositeAccount) {
      oppositeAccount = await fetchAccountWithReference(args.oppositeAccount, fetchAccountParams);
    }

    // Load hosted accounts
    if (args.hostedAccounts) {
      hostedAccounts = await fetchAccountsWithReferences(args.hostedAccounts, fetchAccountParams);

      hostedAccounts.forEach(hostedAccount => {
        if (hostedAccount.HostCollectiveId !== account.id || !account.isActive) {
          throw new Forbidden('You can only fetch orders from hosted accounts of the specified account');
        }

        // When hostContext is INTERNAL, validate that all accounts are the host account itself or its children
        if (args.hostContext === 'INTERNAL') {
          const isHostAccount = hostedAccount.id === account.id;
          const isHostChildAccount = hostedAccount.ParentCollectiveId === account.id;
          if (!isHostAccount && !isHostChildAccount) {
            throw new Forbidden(
              'You can only fetch orders from the host account or its children with host context set to INTERNAL',
            );
          }
        }
      });
    }

    const accountOrConditions = [];
    const oppositeAccountOrConditions = [];

    // Filter on fromCollective
    if (!args.filter || args.filter === 'OUTGOING') {
      accountOrConditions.push(
        getCollectivesJoinCondition(
          account,
          'fromCollective',
          args.includeChildrenAccounts,
          hostContext,
          hostedAccounts,
        ),
      );
      if (oppositeAccount) {
        oppositeAccountOrConditions.push(getCollectivesJoinCondition(oppositeAccount, 'collective'));
      }
      if (args.includeIncognito) {
        // Needs to be root or admin of the profile to see incognito orders
        if (
          (req.remoteUser?.isAdminOfCollective(account) && checkScope(req, 'incognito')) ||
          (req.remoteUser?.isRoot() && checkScope(req, 'root'))
        ) {
          const incognitoProfile = await account.getIncognitoProfile();
          if (incognitoProfile) {
            accountOrConditions.push(getCollectivesJoinCondition(incognitoProfile, 'fromCollective'));
          }
        } else {
          // Is this desirable? Some current tests don't like it.
          // throw new Error('Only admins and root can fetch incognito orders');
        }
      }
      if (host) {
        where[Op.and].push({
          '$collective.HostCollectiveId$': host.id,
          '$collective.approvedAt$': { [Op.not]: null },
        });
      }
    }

    // Filter on collective
    if (!args.filter || args.filter === 'INCOMING') {
      // const collectivesJoinCondition = getCollectivesJoinCondition(
      //   account,
      //   'collective',
      //   args.includeChildrenAccounts,
      //   args.hostContext,
      //   hostedAccounts,
      // );
      // console.log(collectivesJoinCondition);
      accountOrConditions.push(
        getCollectivesJoinCondition(account, 'collective', args.includeChildrenAccounts, hostContext, hostedAccounts),
      );
      if (oppositeAccount) {
        oppositeAccountOrConditions.push(getCollectivesJoinCondition(oppositeAccount, 'fromCollective'));
      }
    }

    // Bind account conditions to the query
    where[Op.and].push(accountOrConditions.length === 1 ? accountOrConditions : { [Op.or]: accountOrConditions });
    if (oppositeAccountOrConditions.length > 0) {
      where[Op.and].push(
        oppositeAccountOrConditions.length === 1
          ? oppositeAccountOrConditions
          : { [Op.or]: oppositeAccountOrConditions },
      );
    }
  }

  // Load payment method
  if (args.paymentMethod) {
    const paymentMethods = await fetchPaymentMethodWithReferences(args.paymentMethod, {
      sequelizeOpts: { attributes: ['id'], include: [{ model: models.Collective }] },
    });
    if (!paymentMethods.every(paymentMethod => req.remoteUser?.isAdminOfCollective(paymentMethod.Collective))) {
      throw new Unauthorized('You must be an admin of the payment method to fetch its orders');
    }
    where['PaymentMethodId'] = { [Op.in]: [...new Set(paymentMethods.map(pm => pm.id))] };
  }

  // Filter on payment method service/type
  if (args.paymentMethodService || args.paymentMethodType) {
    const paymentMethodInclude = { association: 'paymentMethod', required: true, where: {} };
    if (args.paymentMethodService) {
      paymentMethodInclude.where['service'] = args.paymentMethodService;
    }
    if (args.paymentMethodType) {
      paymentMethodInclude.where['type'] = args.paymentMethodType;
    }
    include.push(paymentMethodInclude);
  }

  const isHostAdmin = account?.isHostAccount && includeHostedAccounts && req.remoteUser?.isAdminOfCollective(account);

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
    emailFields: isHostAdmin ? ['$createdByUser.email$'] : [],
    amountFields: ['totalAmount'],
    stringArrayFields: ['tags'],
    stringArrayTransformFn: (str: string) => str.toLowerCase(), // expense tags are stored lowercase
  });

  if (searchTermConditions.length) {
    where[Op.and].push({ [Op.or]: searchTermConditions });
    if (
      searchTermConditions.some(conditionals => Object.keys(conditionals).some(key => key.includes('createdByUser')))
    ) {
      include.push({
        association: 'createdByUser',
        attributes: [],
      });
    }
  }

  // Add filters
  if (args.amount?.gte || args.amount?.lte) {
    if (args.amount.gte && args.amount.lte) {
      assert(args.amount.gte.currency === args.amount.lte.currency, 'Amount range must have the same currency');
    }
    const currency = args.amount.gte?.currency || args.amount.lte?.currency;
    const gte = args.amount.gte && getValueInCentsFromAmountInput(args.amount.gte);
    const lte = args.amount.lte && getValueInCentsFromAmountInput(args.amount.lte);
    const operator =
      args.amount.gte && args.amount.lte
        ? gte === lte
          ? { [Op.eq]: gte }
          : { [Op.between]: [gte, lte] }
        : args.amount.gte
          ? { [Op.gte]: gte }
          : { [Op.lte]: lte };

    where[Op.and].push(
      sequelize.where(
        sequelize.literal(
          SequelizeUtils.formatNamedParameters(
            `
            CASE
              WHEN "Order"."currency" = :currency THEN "Order"."totalAmount"
              ELSE COALESCE(
                (SELECT rate FROM "CurrencyExchangeRates"
                  WHERE "from" = "Order"."currency"
                  AND "to" = :currency
                  -- Most recent rate that is older than the expense, thanks to the combination of "<=" + ORDER BY DESC + LIMIT 1
                  AND "createdAt" <= COALESCE("Order"."processedAt", "Order"."createdAt")
                  ORDER BY "createdAt" DESC
                  LIMIT 1
                ) * "Order"."totalAmount",
                "Order"."totalAmount"
              )
            END
          `,
            { currency },
            'postgres',
          ),
        ),
        operator,
      ),
    );
  } else {
    if (args.minAmount) {
      where['totalAmount'] = { [Op.gte]: args.minAmount };
    }
    if (args.maxAmount) {
      where['totalAmount'] = { ...where['totalAmount'], [Op.lte]: args.maxAmount };
    }
  }

  if (args.dateFrom) {
    where['createdAt'] = { [Op.gte]: args.dateFrom };
  }
  if (args.dateTo) {
    where['createdAt'] = where['createdAt'] || {};
    where['createdAt'][Op.lte] = args.dateTo;
  }
  if (args.expectedDateFrom) {
    where['data.expectedAt'] = { [Op.gte]: args.expectedDateFrom };
  }
  if (args.expectedDateTo) {
    where['data.expectedAt'] = where['data.expectedAt'] || {};
    where['data.expectedAt'][Op.lte] = args.expectedDateTo;
  }

  if (args.chargedDateFrom) {
    where[Op.and].push(
      sequelize.where(sequelize.literal(`COALESCE("Subscription"."lastChargedAt", "Order"."createdAt")`), {
        [Op.gte]: args.chargedDateFrom,
      }),
    );
  }
  if (args.chargedDateTo) {
    where[Op.and].push(
      sequelize.where(sequelize.literal(`COALESCE("Subscription"."lastChargedAt", "Order"."createdAt")`), {
        [Op.lte]: args.chargedDateTo,
      }),
    );
  }

  if (args.status && args.status.length > 0) {
    where['status'] = { [Op.in]: args.status };
    if (args.status.includes(OrderStatuses.PAUSED) && args.pausedBy) {
      where['data.pausedBy'] = { [Op.in]: args.pausedBy };
    }
  }

  if (args.tier) {
    const tierIds = args.tier.map(getDatabaseIdFromTierReference);
    include.push({ association: 'Tier', required: true, where: { id: { [Op.in]: tierIds } } });
  }

  if (args.frequency) {
    if (args.frequency.includes('ONETIME')) {
      where['SubscriptionId'] = { [Op.is]: null };
    } else {
      const intervals = compact([
        args.frequency.includes('MONTHLY') && 'month',
        args.frequency.includes('YEARLY') && 'year',
      ]);
      where[Op.and].push({
        ['$Subscription.interval$']: { [Op.in]: intervals },
      });
    }
  } else if (args.onlySubscriptions) {
    where[Op.and].push({
      [Op.or]: [
        { ['$Subscription.id$']: { [Op.ne]: null } },
        { interval: { [Op.in]: ['year', 'month'] }, status: 'PROCESSING' },
      ],
    });
  } else if (args.onlyActiveSubscriptions) {
    where[Op.and].push({
      ['$Subscription.isActive$']: true,
    });
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

  // use 'true' literal to avoid casting and allow index use when sequelize generates these nested json queries
  if (args.expectedFundsFilter) {
    if (args.expectedFundsFilter === 'ONLY_MANUAL') {
      where['data.isManualContribution'] = 'true';
    } else if (args.expectedFundsFilter === 'ONLY_PENDING') {
      where['data.isPendingContribution'] = 'true';
    } else {
      where[Op.or] = where[Op.or] || {};
      where[Op.or]['data.isPendingContribution'] = 'true';
      where[Op.or]['data.isManualContribution'] = 'true';
    }
  } else if (!where['status']) {
    where['status'] = { ...where['status'], [Op.ne]: OrderStatuses.PENDING };
  }

  let order: Order;
  if (args.orderBy.field === 'lastChargedAt') {
    order = [
      [sequelize.literal(`COALESCE("Subscription"."lastChargedAt", "Order"."createdAt")`), args.orderBy.direction],
    ];
  } else {
    order = [[args.orderBy.field, args.orderBy.direction]];
  }
  const { offset, limit } = args;
  return {
    nodes: () => models.Order.findAll({ include, where, order, offset, limit }),
    totalCount: () => models.Order.count({ include, where }),
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
