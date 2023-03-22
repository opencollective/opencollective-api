import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { get, has, isNull, merge, omitBy, sortBy } from 'lodash';
import moment from 'moment';
import sequelize from 'sequelize';
import SqlString from 'sequelize/lib/sql-string';

import { types } from '../../constants/collectives';
import FEATURE, { FeaturesList } from '../../constants/feature';
import FEATURE_STATUS from '../../constants/feature-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import roles from '../../constants/roles';
import { isCollectiveDeletable } from '../../lib/collectivelib';
import { filterContributors } from '../../lib/contributors';
import queries from '../../lib/queries';
import { canSeeLegalName } from '../../lib/user-permissions';
import models, { Op } from '../../models';
import { hostResolver } from '../common/collective';
import { getContextPermission, PERMISSION_TYPE } from '../common/context-permissions';
import { getFeatureStatusResolver } from '../common/features';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../v2/identifiers';
import { Policies } from '../v2/object/Policies';
import { SocialLink } from '../v2/object/SocialLink';

import { ApplicationType } from './Application';
import { TransactionInterfaceType } from './TransactionInterface';
import {
  ConnectedAccountType,
  ContributorRoleEnum,
  ContributorType,
  DateString,
  ExpenseType,
  ImageFormatType,
  LocationType,
  MemberType,
  NotificationType,
  OrderDirectionType,
  OrderStatusType,
  OrderType,
  PaginatedPaymentMethodsType,
  PaymentMethodBatchInfo,
  PaymentMethodType,
  PayoutMethodType,
  TierType,
  UpdateType,
  UserType,
} from './types';

export const TypeOfCollectiveType = new GraphQLEnumType({
  name: 'TypeOfCollective',
  values: {
    COLLECTIVE: {},
    EVENT: {},
    ORGANIZATION: {},
    USER: {},
    BOT: {},
    PROJECT: {},
    FUND: {},
    VENDOR: {},
  },
});

export const CollectiveOrderFieldType = new GraphQLEnumType({
  name: 'CollectiveOrderField',
  description: 'Properties by which collectives can be ordered.',
  values: {
    monthlySpending: {
      description: 'Order collectives by their average monthly spending (based on last 90 days)',
    },
    balance: {
      description: 'Order collectives by total balance.',
    },
    createdAt: {
      description: 'Order collectives by creation time.',
    },
    name: {
      description: 'Order collectives by name.',
    },
    slug: {
      description: 'Order collectives by slug.',
    },
    updatedAt: {
      description: 'Order collectives by updated time.',
    },
    totalDonations: {
      description: 'Order collectives by total donations.',
    },
    financialContributors: {
      description: 'Order collectives by number of financial contributors (unique members).',
    },
  },
});

export const PaymentMethodOrderFieldType = new GraphQLEnumType({
  name: 'PaymenMethodOrderField',
  description: 'Properties by which PaymenMethods can be ordered',
  values: {
    type: {
      description: 'Order payment methods by type (creditcard, giftcard, etc.)',
    },
  },
});

export const HostCollectiveOrderFieldType = new GraphQLEnumType({
  name: 'HostCollectiveOrderFieldType',
  description: 'Properties by which hosts can be ordered.',
  values: {
    createdAt: {
      description: 'Order hosts by creation time.',
    },
    name: {
      description: 'Order hosts by name.',
    },
    collectives: {
      description: 'Order hosts by number of collectives it is hosting.',
    },
    updatedAt: {
      description: 'Order hosts by updated time.',
    },
  },
});

export const BackersStatsType = new GraphQLObjectType({
  name: 'BackersStatsType',
  description: 'Breakdown of backers per type (ANY/USER/ORGANIZATION/COLLECTIVE)',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching
      id: {
        type: GraphQLInt,
        resolve(stats) {
          return stats.id;
        },
      },
      all: {
        description: 'Total number of backers that have given money to this collective',
        type: GraphQLInt,
        resolve(stats) {
          return stats.all;
        },
      },
      users: {
        description: 'Number of individuals that have given money to this collective',
        type: GraphQLInt,
        resolve(stats) {
          return stats.USER || 0;
        },
      },
      organizations: {
        description: 'Number of organizations that have given money to this collective',
        type: GraphQLInt,
        resolve(stats) {
          return stats.ORGANIZATION || 0;
        },
      },
      collectives: {
        description: 'Number of collectives that have given money to this collective',
        type: GraphQLInt,
        resolve(stats) {
          return stats.COLLECTIVE || 0;
        },
      },
    };
  },
});

export const CollectivesStatsType = new GraphQLObjectType({
  name: 'CollectivesStatsType',
  description: 'Breakdown of collectives under this collective by role (all/hosted/memberOf/events)',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching
      id: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.id;
        },
      },
      all: {
        type: GraphQLInt,
        async resolve(collective) {
          return models.Collective.count({
            where: {
              [Op.or]: {
                ParentCollectiveId: collective.id,
                HostCollectiveId: collective.id,
              },
              isActive: true,
            },
          });
        },
      },
      hosted: {
        type: GraphQLInt,
        description: 'Returns the collectives hosted by this collective',
        async resolve(host, _, req) {
          return req.loaders.Collective.hostedCollectivesCount.load(host.id);
        },
      },
      memberOf: {
        type: GraphQLInt,
        description: 'Returns the number of collectives that have this collective has parent',
        async resolve(collective) {
          return models.Collective.count({
            where: {
              ParentCollectiveId: collective.id,
              type: [types.COLLECTIVE, types.ORGANIZATION],
              isActive: true,
            },
          });
        },
      },
      events: {
        type: GraphQLInt,
        description: 'Returns the number of events that have this collective has parent',
        async resolve(collective) {
          return models.Collective.count({
            where: {
              ParentCollectiveId: collective.id,
              type: types.EVENT,
              isActive: true,
            },
          });
        },
      },
    };
  },
});

export const PlanType = new GraphQLObjectType({
  name: 'PlanType',
  description: 'The name of the current plan and its characteristics.',
  fields: () => ({
    // We always have to return an id for apollo's caching
    id: {
      type: GraphQLInt,
      resolve(collective) {
        return collective.id;
      },
    },
    name: {
      type: GraphQLString,
    },
    hostedCollectives: {
      type: GraphQLInt,
    },
    hostedCollectivesLimit: {
      type: GraphQLInt,
    },
    addedFunds: {
      type: GraphQLInt,
    },
    addedFundsLimit: {
      type: GraphQLInt,
    },
    hostDashboard: {
      type: GraphQLBoolean,
    },
    manualPayments: {
      type: GraphQLBoolean,
    },
    bankTransfers: {
      type: GraphQLInt,
    },
    bankTransfersLimit: {
      type: GraphQLInt,
    },
    transferwisePayouts: {
      type: GraphQLInt,
    },
    transferwisePayoutsLimit: {
      type: GraphQLInt,
    },
    hostFees: {
      type: GraphQLBoolean,
    },
    hostFeeSharePercent: {
      type: GraphQLFloat,
    },
    platformTips: {
      type: GraphQLBoolean,
    },
  }),
});

export const ExpensesStatsType = new GraphQLObjectType({
  name: 'ExpensesStatsType',
  description: 'Breakdown of expenses per status (ALL/PENDING/APPROVED/PAID/REJECTED)',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching
      id: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.id;
        },
      },
      all: {
        type: GraphQLInt,
        async resolve(collective, args, req) {
          const expenses = (await req.loaders.Collective.stats.expenses.load(collective.id)) || {};
          let count = 0;
          Object.keys(expenses).forEach(status => (count += (status !== 'CollectiveId' && expenses[status]) || 0));
          return count;
        },
      },
      pending: {
        type: GraphQLInt,
        description: 'Returns the number of expenses that are pending',
        async resolve(collective, args, req) {
          const expenses = (await req.loaders.Collective.stats.expenses.load(collective.id)) || {};
          return expenses.PENDING || 0;
        },
      },
      approved: {
        type: GraphQLInt,
        description: 'Returns the number of expenses that are approved',
        async resolve(collective, args, req) {
          const expenses = (await req.loaders.Collective.stats.expenses.load(collective.id)) || {};
          return expenses.APPROVED || 0;
        },
      },
      rejected: {
        type: GraphQLInt,
        description: 'Returns the number of expenses that are rejected',
        async resolve(collective, args, req) {
          const expenses = (await req.loaders.Collective.stats.expenses.load(collective.id)) || {};
          return expenses.REJECTED || 0;
        },
      },
      paid: {
        type: GraphQLInt,
        description: 'Returns the number of expenses that are paid',
        async resolve(collective, args, req) {
          const expenses = (await req.loaders.Collective.stats.expenses.load(collective.id)) || {};
          return expenses.PAID || 0;
        },
      },
    };
  },
});

export const TransactionsStatsType = new GraphQLObjectType({
  name: 'TransactionsStatsType',
  description: 'Breakdown of transactions per type (ALL/CREDIT/DEBIT)',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching
      id: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.id;
        },
      },
      all: {
        type: GraphQLInt,
        resolve(collective) {
          return models.Transaction.count({
            where: { CollectiveId: collective.id },
          });
        },
      },
      credit: {
        type: GraphQLInt,
        description: 'Returns the number of CREDIT transactions',
        resolve(collective) {
          return models.Transaction.count({
            where: { CollectiveId: collective.id, type: 'CREDIT' },
          });
        },
      },
      debit: {
        type: GraphQLInt,
        description: 'Returns the number of DEBIT transactions',
        async resolve(collective) {
          return models.Transaction.count({
            where: { CollectiveId: collective.id, type: 'DEBIT' },
          });
        },
      },
    };
  },
});

export const CollectiveStatsType = new GraphQLObjectType({
  name: 'CollectiveStatsType',
  description: 'Stats for the collective',
  fields: () => {
    return {
      // We always have to return an id for apollo's caching
      id: {
        type: GraphQLInt,
        resolve(collective) {
          return collective.id;
        },
      },
      balanceWithBlockedFunds: {
        description: 'Amount of money in cents in the currency of the collective currently available to spend',
        type: GraphQLInt,
        resolve(collective, args, req) {
          return collective.getBalanceWithBlockedFunds({ loaders: req.loaders });
        },
      },
      balance: {
        description: 'Amount of money in cents in the currency of the collective.',
        type: GraphQLInt,
        resolve(collective, args, req) {
          return collective.getBalance({ loaders: req.loaders });
        },
      },
      backers: {
        description: 'Breakdown of all backers of this collective',
        type: BackersStatsType,
        resolve(collective, args, req) {
          return req.loaders.Collective.stats.backers.load(collective.id);
        },
      },
      collectives: {
        description: 'Number of collectives under this collective',
        type: CollectivesStatsType,
        resolve(collective) {
          return collective;
        },
      },
      updates: {
        description: 'Number of updates published by this collective',
        type: GraphQLInt,
        resolve(collective) {
          return models.Update.count({
            where: {
              CollectiveId: collective.id,
              publishedAt: { [Op.ne]: null },
            },
          });
        },
      },
      events: {
        description: 'Number of events under this collective',
        type: GraphQLInt,
        resolve(collective) {
          return models.Collective.count({
            where: { ParentCollectiveId: collective.id, type: types.EVENT },
          });
        },
      },
      expenses: {
        description: 'Breakdown of expenses submitted to this collective by type (ALL/PENDING/APPROVED/PAID/REJECTED)',
        type: ExpensesStatsType,
        resolve(collective) {
          return collective;
        },
      },
      transactions: {
        description: 'Number of transactions',
        type: TransactionsStatsType,
        resolve(collective) {
          return collective;
        },
      },
      monthlySpending: {
        description: 'Average amount spent per month based on the last 90 days',
        type: GraphQLInt,
        resolve(collective) {
          // if we fetched the collective with the raw query to sort them by their monthly spending we don't need to recompute it
          if (has(collective, 'dataValues.monthlySpending')) {
            return get(collective, 'dataValues.monthlySpending');
          } else {
            return collective.getMonthlySpending();
          }
        },
      },
      totalAmountSpent: {
        description: 'Total amount spent',
        type: GraphQLInt,
        resolve(collective, _, req) {
          return collective.getTotalAmountSpent({ loaders: req.loaders, net: true });
        },
      },
      totalAmountReceived: {
        description: 'Total amount received',
        type: GraphQLInt,
        args: {
          startDate: { type: DateString },
          endDate: { type: DateString },
          periodInMonths: {
            type: GraphQLInt,
            description: 'Computes contributions from the last x months. Cannot be used with startDate/endDate',
          },
        },
        resolve(collective, args, req) {
          let startDate = args.startDate ? new Date(args.startDate) : null;
          let endDate = args.endDate ? new Date(args.endDate) : null;

          if (args.periodInMonths) {
            startDate = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            endDate = null;
          }

          return collective.getTotalAmountReceived({ loaders: req.loaders, startDate, endDate });
        },
      },
      totalNetAmountReceived: {
        description: 'Total net amount received',
        type: GraphQLInt,
        resolve(collective, _, req) {
          return collective.getTotalAmountReceived({ loaders: req.loaders, net: true });
        },
      },
      yearlyBudget: {
        type: GraphQLInt,
        resolve(collective, args, req) {
          return collective.getYearlyBudget({ loaders: req.loaders });
        },
      },
      yearlyBudgetManaged: {
        type: GraphQLInt,
        deprecationReason: '2023-03-01: This field will be removed soon, please use totalMoneyManaged from GraphQL V2',
        resolve(collective) {
          if (collective.isHostAccount) {
            return queries.getTotalAnnualBudgetForHost(collective.id);
          } else {
            return 0;
          }
        },
      },
      activeRecurringContributions: {
        type: GraphQLJSON,
        resolve(collective, args, req) {
          return req.loaders.Collective.stats.activeRecurringContributions.load(collective.id);
        },
      },
    };
  },
});

export const CollectiveInterfaceType = new GraphQLInterfaceType({
  name: 'CollectiveInterface',
  description: 'Collective interface',
  resolveType: collective => {
    switch (collective.type) {
      case types.COLLECTIVE:
      case types.BOT:
        return 'Collective';

      case types.USER:
        return 'User';

      case types.ORGANIZATION:
        return 'Organization';

      case types.EVENT:
        return 'Event';

      case types.PROJECT:
        return 'Project';

      case types.FUND:
        return 'Fund';

      case types.VENDOR:
        return 'Vendor';

      default:
        return null;
    }
  },
  fields: () => {
    return {
      id: { type: GraphQLInt },
      createdByUser: { type: UserType },
      parentCollective: { type: CollectiveInterfaceType },
      children: { type: new GraphQLNonNull(new GraphQLList(CollectiveInterfaceType)) },
      type: { type: GraphQLString },
      isActive: { type: GraphQLBoolean },
      name: { type: GraphQLString },
      legalName: { type: GraphQLString },
      company: { type: GraphQLString },
      description: { type: GraphQLString },
      longDescription: { type: GraphQLString },
      expensePolicy: { type: GraphQLString },
      tags: { type: new GraphQLList(GraphQLString) },
      location: {
        type: LocationType,
        description: 'Name, address, country, lat, long of the location.',
      },
      createdAt: { type: DateString },
      startsAt: { type: DateString },
      endsAt: { type: DateString },
      timezone: { type: GraphQLString },
      hostFeePercent: { type: GraphQLFloat },
      platformFeePercent: { type: GraphQLFloat },
      currency: { type: GraphQLString },
      image: { type: GraphQLString },
      imageUrl: {
        type: GraphQLString,
        args: {
          height: { type: GraphQLInt },
          format: {
            type: ImageFormatType,
          },
        },
      },
      backgroundImage: { type: GraphQLString },
      backgroundImageUrl: {
        type: GraphQLString,
        args: {
          height: { type: GraphQLInt },
          format: {
            type: ImageFormatType,
          },
        },
      },
      settings: { type: new GraphQLNonNull(GraphQLJSON) },
      isPledged: {
        description: 'Defines if a collective is pledged',
        type: GraphQLBoolean,
      },
      data: {
        type: GraphQLJSON,
        deprecationReason: '2020-10-08: This field is not provided anymore and will return an empty object',
      },
      privateInstructions: {
        type: GraphQLString,
        description: 'Private instructions related to an event',
      },
      githubContributors: { type: new GraphQLNonNull(GraphQLJSON) },
      slug: { type: GraphQLString },
      path: { type: GraphQLString },
      isHost: { type: GraphQLBoolean },
      isIncognito: { type: GraphQLBoolean },
      isFrozen: { type: new GraphQLNonNull(GraphQLBoolean), description: 'Whether this account is frozen' },
      isGuest: { type: GraphQLBoolean },
      canApply: { type: GraphQLBoolean },
      canContact: { type: GraphQLBoolean },
      isArchived: { type: GraphQLBoolean },
      isApproved: { type: GraphQLBoolean },
      isDeletable: { type: GraphQLBoolean },
      host: { type: CollectiveInterfaceType },
      hostCollective: { type: CollectiveInterfaceType },
      members: {
        type: new GraphQLList(MemberType),
        description:
          'List of all collectives that are related to this collective with their membership relationship. Can filter by role (BACKER/MEMBER/ADMIN/HOST/FOLLOWER)',
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          type: {
            type: GraphQLString,
            description: 'Type of User: USER/ORGANIZATION',
          },
          TierId: { type: GraphQLInt },
          tierSlug: { type: GraphQLString },
          role: { type: GraphQLString },
          roles: { type: new GraphQLList(GraphQLString) },
        },
      },
      memberOf: {
        type: new GraphQLList(MemberType),
        description:
          'List of all collectives that this collective is a member of with their membership relationship. Can filter by role (BACKER/MEMBER/ADMIN/HOST/FOLLOWER)',
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          type: {
            type: GraphQLString,
            description: 'Type of collective (COLLECTIVE, EVENT, ORGANIZATION)',
          },
          role: { type: GraphQLString },
          roles: { type: new GraphQLList(GraphQLString) },
          onlyActiveCollectives: {
            type: GraphQLBoolean,
            description: 'Only return memberships for active collectives (that have been approved by the host)',
            defaultValue: false,
          },
          includeIncognito: {
            type: GraphQLBoolean,
            defaultValue: true,
            description:
              'Whether incognito profiles should be included in the result. Only works if requesting user is an admin of the account.',
          },
        },
      },
      contributors: {
        type: new GraphQLList(ContributorType),
        description: 'All the persons and entities that contribute to this organization',
        args: {
          limit: { type: GraphQLInt, defaultValue: 1000 },
          roles: { type: new GraphQLList(ContributorRoleEnum) },
        },
      },
      collectives: {
        type: CollectiveSearchResultsType,
        description: 'List of all collectives hosted by this collective',
        args: {
          orderBy: { defaultValue: 'name', type: CollectiveOrderFieldType },
          orderDirection: { defaultValue: 'ASC', type: OrderDirectionType },
          expenseStatus: { defaultValue: null, type: GraphQLString },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          isActive: { type: GraphQLBoolean },
          isArchived: { type: GraphQLBoolean },
        },
      },
      followers: {
        type: new GraphQLList(CollectiveInterfaceType),
        description: 'List of all followers of this collective',
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
      },
      notifications: {
        type: new GraphQLList(NotificationType),
        description: 'List of all notifications for this collective',
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          channel: { type: GraphQLString },
          type: { type: GraphQLString },
          active: { type: GraphQLBoolean },
        },
      },
      tiers: {
        type: new GraphQLList(TierType),
        args: {
          id: { type: GraphQLInt },
          slug: { type: GraphQLString },
          slugs: { type: new GraphQLList(GraphQLString) },
        },
      },
      orders: {
        type: new GraphQLList(OrderType),
        args: {
          status: { type: OrderStatusType },
        },
      },
      ordersFromCollective: {
        type: new GraphQLList(OrderType),
        args: {
          subscriptionsOnly: { type: GraphQLBoolean },
        },
      },
      stats: { type: CollectiveStatsType },
      transactions: {
        type: new GraphQLList(TransactionInterfaceType),
        args: {
          type: { type: GraphQLString },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          includeExpenseTransactions: { type: GraphQLBoolean },
        },
      },
      expenses: {
        type: new GraphQLList(ExpenseType),
        args: {
          type: { type: GraphQLString },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          status: { type: GraphQLString },
          includeHostedCollectives: { type: GraphQLBoolean },
        },
      },
      supportedExpenseTypes: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
        description: 'The list of expense types supported by this account',
      },
      role: { type: GraphQLString },
      twitterHandle: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
      githubHandle: { type: GraphQLString, deprecationReason: '2022-06-03: Please use repositoryUrl' },
      repositoryUrl: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
      website: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
      socialLinks: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SocialLink))),
      },
      updates: {
        type: new GraphQLList(UpdateType),
        deprecationReason: '2022-09-09: Updates moved to GQLV2',
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          onlyPublishedUpdates: { type: GraphQLBoolean },
        },
      },
      events: {
        type: new GraphQLList(EventCollectiveType),
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          includePastEvents: {
            type: GraphQLBoolean,
            defaultValue: false,
            description: 'Include past events',
          },
          includeInactive: {
            type: GraphQLBoolean,
            defaultValue: false,
            description: 'Include inactive events',
          },
        },
      },
      projects: {
        type: new GraphQLList(ProjectCollectiveType),
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        },
      },
      paymentMethods: {
        type: new GraphQLList(PaymentMethodType),
        args: {
          service: { type: GraphQLString },
          limit: { type: GraphQLInt },
          hasBalanceAboveZero: { type: GraphQLBoolean },
          isConfirmed: {
            type: GraphQLBoolean,
            description: 'Only return confirmed payment methods',
            defaultValue: true,
          },
          type: {
            type: new GraphQLList(GraphQLString),
            description: 'Filter on given types  (creditcard, giftcard, etc.)',
          },
          orderBy: {
            type: PaymentMethodOrderFieldType,
            description: 'Order entries based on given column. Set to null for no ordering.',
          },
          includeHostCollectivePaymentMethod: {
            type: GraphQLBoolean,
            defaultValue: false,
            description: 'Defines if the host "collective" payment method should be returned',
          },
        },
      },
      payoutMethods: {
        type: new GraphQLList(PayoutMethodType),
        description: 'The list of payout methods that this collective can use to get paid',
      },
      giftCardsBatches: {
        type: new GraphQLList(PaymentMethodBatchInfo),
        description:
          'List all the gift cards batches emitted by this collective. May include `null` as key for unbatched gift cards.',
      },
      createdGiftCards: {
        type: PaginatedPaymentMethodsType,
        args: {
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
          batch: { type: GraphQLString },
          isConfirmed: {
            type: GraphQLBoolean,
            description: 'Whether the gift card has been claimed or not',
          },
        },
      },
      connectedAccounts: { type: new GraphQLList(ConnectedAccountType) },
      features: {
        type: new GraphQLNonNull(CollectiveFeatures),
        description: 'Describes the features enabled and available for this collective',
      },
      plan: { type: PlanType },
      contributionPolicy: { type: GraphQLString },
      categories: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
        description: 'Categories set by Open Collective to help moderation.',
      },
      policies: {
        type: new GraphQLNonNull(Policies),
        description:
          'Policies for the account. To see non-public policies you need to be admin and have the scope: "account".',
      },
    };
  },
});

const FeaturesFields = () => {
  return FeaturesList.reduce(
    (obj, feature) =>
      Object.assign(obj, {
        [feature]: {
          type: CollectiveFeatureStatus,
          resolve: getFeatureStatusResolver(feature),
        },
      }),
    {},
  );
};

const CollectiveFields = () => {
  return {
    id: {
      type: GraphQLInt,
      resolve(collective) {
        return collective.id;
      },
    },
    createdByUser: {
      type: UserType,
      async resolve(collective, args, req) {
        // Vendors don't have a `createdByUser`
        if (!collective.CreatedByUserId) {
          return null;
        }

        // If the profile is incognito, remoteUser must be allowed to see its `createdByUser`
        const user = await req.loaders.User.byId.load(collective.CreatedByUserId);
        if (
          user &&
          (!collective.isIncognito || (await req.loaders.Collective.canSeePrivateInfo.load(user.CollectiveId)))
        ) {
          return user;
        } else {
          return {};
        }
      },
    },
    parentCollective: {
      type: CollectiveInterfaceType,
      resolve(collective) {
        return models.Collective.findByPk(collective.ParentCollectiveId);
      },
    },
    children: {
      type: new GraphQLNonNull(new GraphQLList(CollectiveInterfaceType)),
      resolve(collective) {
        return collective.getChildren();
      },
    },
    type: {
      type: GraphQLString,
      resolve(collective) {
        return collective.type;
      },
    },
    isActive: {
      type: GraphQLBoolean,
      resolve(collective) {
        return collective.isActive;
      },
    },
    name: {
      type: GraphQLString,
      resolve(collective) {
        return collective.name;
      },
    },
    legalName: {
      type: GraphQLString,
      async resolve(collective, _, req) {
        if (
          !canSeeLegalName(req.remoteUser, collective) &&
          !getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_LEGAL_NAME, collective.id)
        ) {
          return null;
        } else if (collective.isIncognito) {
          const mainProfile = await req.loaders.Collective.mainProfileFromIncognito.load(collective.id);
          if (mainProfile) {
            return mainProfile.legalName || mainProfile.name;
          }
        } else {
          return collective.legalName;
        }
      },
    },
    company: {
      type: GraphQLString,
      resolve(collective) {
        return collective.company;
      },
    },
    description: {
      type: GraphQLString,
      resolve(collective) {
        return collective.description;
      },
    },
    longDescription: {
      type: GraphQLString,
      resolve(collective) {
        return collective.longDescription;
      },
    },
    expensePolicy: {
      type: GraphQLString,
      resolve(collective) {
        return collective.expensePolicy;
      },
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      resolve(collective) {
        return collective.tags;
      },
    },
    location: {
      type: LocationType,
      description: 'Name, address, lat, long of the location.',
      async resolve(collective, _, req) {
        const publicAddressesCollectiveTypes = [types.COLLECTIVE, types.EVENT, types.ORGANIZATION];
        if (publicAddressesCollectiveTypes.includes(collective.type)) {
          return collective.getLocation();
        } else if (!req.remoteUser) {
          return null;
        } else if (req.remoteUser.isAdminOfCollective(collective)) {
          // For incognito profiles, we retrieve the location from the main user profile
          if (collective.isIncognito) {
            const mainProfile = await req.loaders.Collective.mainProfileFromIncognito.load(collective.id);
            if (mainProfile) {
              return mainProfile.getLocation();
            }
          }

          return collective.getLocation();
        } else if (await req.loaders.Collective.canSeePrivateInfo.load(collective.id)) {
          return collective.getLocation();
        }
      },
    },
    createdAt: {
      type: DateString,
      resolve(collective) {
        return collective.createdAt;
      },
    },
    startsAt: {
      type: DateString,
      resolve(collective) {
        return collective.startsAt;
      },
    },
    endsAt: {
      type: DateString,
      resolve(collective) {
        return collective.endsAt;
      },
    },
    timezone: {
      type: GraphQLString,
      resolve(collective) {
        return collective.timezone;
      },
    },
    hostFeePercent: {
      type: GraphQLFloat,
      resolve(collective) {
        return collective.hostFeePercent;
      },
    },
    platformFeePercent: {
      type: GraphQLFloat,
      resolve(collective) {
        return collective.platformFeePercent;
      },
    },
    currency: {
      type: GraphQLString,
      resolve(collective) {
        return collective.currency;
      },
    },
    image: {
      type: GraphQLString,
      async resolve(collective, args, req) {
        if (collective.type === 'EVENT' && !collective.image) {
          const parentCollective = await req.loaders.Collective.byId.load(collective.ParentCollectiveId);
          if (parentCollective) {
            return parentCollective.image;
          }
        }
        return collective.image;
      },
    },
    imageUrl: {
      type: GraphQLString,
      args: {
        height: { type: GraphQLInt },
        format: {
          type: ImageFormatType,
        },
      },
      async resolve(collective, args, req) {
        if (collective.type === 'EVENT' && !collective.image) {
          const parentCollective = await req.loaders.Collective.byId.load(collective.ParentCollectiveId);
          if (parentCollective) {
            return parentCollective.getImageUrl(args);
          }
        }
        return collective.getImageUrl(args);
      },
    },
    backgroundImage: {
      type: GraphQLString,
      resolve(collective) {
        return collective.backgroundImage;
      },
    },
    backgroundImageUrl: {
      type: GraphQLString,
      args: {
        height: { type: GraphQLInt },
        format: {
          type: ImageFormatType,
        },
      },
      resolve(collective, args) {
        return collective.getBackgroundImageUrl(args);
      },
    },
    settings: {
      type: new GraphQLNonNull(GraphQLJSON),
      resolve(collective) {
        return collective.settings;
      },
    },
    isPledged: {
      description: 'Defines if a collective is pledged',
      type: GraphQLBoolean,
      resolve(collective) {
        return collective.isPledged;
      },
    },
    data: {
      type: GraphQLJSON,
      deprecationReason: '2020-10-08: This field is not provided anymore and will return an empty object',
      resolve() {
        return {};
      },
    },
    privateInstructions: {
      type: GraphQLString,
      description: 'Private instructions related to an event',
      resolve(collective, _, req) {
        if (
          collective.type === types.EVENT &&
          (req.remoteUser?.isAdminOfCollective(collective) || req.remoteUser?.hasRole(roles.PARTICIPANT, collective))
        ) {
          return collective.data?.privateInstructions;
        }
      },
    },
    githubContributors: {
      type: new GraphQLNonNull(GraphQLJSON),
      resolve(collective) {
        return collective.data?.githubContributors || {};
      },
    },
    slug: {
      type: GraphQLString,
      resolve(collective) {
        return collective.slug;
      },
    },
    path: {
      type: GraphQLString,
      async resolve(collective) {
        return await collective.getUrlPath();
      },
    },
    isHost: {
      description: 'Returns whether this collective can host other collectives (ie. has a Stripe Account connected)',
      type: GraphQLBoolean,
      resolve(collective) {
        return collective.isHost();
      },
    },
    isTrustedHost: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Returns whether this host is trusted or not',
      resolve: collective => Boolean(get(collective, 'data.isTrustedHost')),
    },
    isTwoFactorAuthEnabled: {
      type: GraphQLBoolean,
      description: 'Returns whether this user has two factor authentication enabled',
      async resolve(collective, _, req) {
        if (req.remoteUser?.isAdmin(collective.id) || req.remoteUser?.isRoot()) {
          if (collective.type === types.USER) {
            const user = await models.User.findOne({
              attributes: ['id', 'twoFactorAuthToken'],
              where: { CollectiveId: collective.id },
            });
            if (user.twoFactorAuthToken) {
              return true;
            }
          }
          return false;
        } else {
          return null;
        }
      },
    },
    canApply: {
      description: 'Returns whether this host accepts applications for new collectives',
      type: GraphQLBoolean,
      resolve(collective) {
        return collective.canApply();
      },
    },
    canContact: {
      description: 'Returns whether this collectives can be contacted',
      type: GraphQLBoolean,
      resolve(collective) {
        return collective.canContact();
      },
    },
    isIncognito: {
      description: 'Returns whether this collective is incognito',
      type: GraphQLBoolean,
      resolve(collective) {
        return collective.isIncognito;
      },
    },
    isGuest: {
      description: 'Returns whether this collective is a guest profile',
      type: GraphQLBoolean,
      resolve(collective) {
        return Boolean(collective.data?.isGuest);
      },
    },
    isFrozen: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether this account is frozen',
      resolve(collective) {
        return get(collective, `data.features.${FEATURE.ALL}`) === false;
      },
    },
    isArchived: {
      description: 'Returns whether this collective is archived',
      type: GraphQLBoolean,
      resolve(collective) {
        return Boolean(collective.deactivatedAt && !collective.isActive);
      },
    },
    isApproved: {
      description: 'Returns whether this collective is approved',
      type: GraphQLBoolean,
      async resolve(collective, _, req) {
        if (!collective.HostCollectiveId) {
          return false;
        } else if (collective.type === types.EVENT) {
          const ParentCollectiveId = collective.ParentCollectiveId;
          const parentCollective = ParentCollectiveId && (await req.loaders.Collective.byId.load(ParentCollectiveId));
          // In the future, we should make it possible to directly read the approvedAt of the event
          return parentCollective && (parentCollective.isHostAccount || parentCollective.isApproved());
        } else {
          return collective.isApproved();
        }
      },
    },
    isDeletable: {
      description: 'Returns whether this collective is deletable',
      type: GraphQLBoolean,
      resolve(collective) {
        return isCollectiveDeletable(collective);
      },
    },
    host: {
      description: 'Get the host collective that is receiving the money on behalf of this collective',
      type: CollectiveInterfaceType,
      resolve: hostResolver,
    },
    hostCollective: {
      description: 'A host might have a collective attached to it',
      type: CollectiveInterfaceType,
      resolve(collective, args, req) {
        if (has(collective.settings, 'hostCollective.id')) {
          return req.loaders.Collective.byId.load(get(collective.settings, 'hostCollective.id'));
        }
        if (collective.id === collective.HostCollectiveId) {
          return collective;
        }
        return null;
      },
    },
    members: {
      description: 'Get all the members of this collective (admins, members, backers, followers)',
      type: new GraphQLList(MemberType),
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        type: { type: GraphQLString },
        role: { type: GraphQLString },
        TierId: { type: GraphQLInt },
        tierSlug: { type: GraphQLString },
        roles: { type: new GraphQLList(GraphQLString) },
      },
      resolve(collective, args, req) {
        if (collective.isIncognito && !req.remoteUser?.isAdmin(collective.id)) {
          return [];
        }

        const query = {
          limit: args.limit,
          offset: args.offset,
          order: [['id', 'ASC']],
        };

        query.where = { CollectiveId: collective.id };
        if (args.TierId) {
          query.where.TierId = args.TierId;
        }
        const roles = args.roles || (args.role && [args.role]);

        if (roles && roles.length > 0) {
          query.where.role = { [Op.in]: roles };
        }

        let conditionOnMemberCollective;
        if (args.type) {
          const types = args.type.split(',');
          conditionOnMemberCollective = { type: { [Op.in]: types } };
        }

        query.include = [
          {
            model: models.Collective,
            as: 'memberCollective',
            required: true,
            where: conditionOnMemberCollective,
          },
        ];

        if (args.tierSlug) {
          query.include.push({
            model: models.Tier,
            where: { slug: args.tierSlug },
          });
        }

        return models.Member.findAll(query);
      },
    },
    memberOf: {
      description: 'Get all the collective this collective is a member of (as a member, backer, follower, etc.)',
      type: new GraphQLList(MemberType),
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        type: {
          type: GraphQLString,
          description: 'Type of collective (COLLECTIVE, EVENT, ORGANIZATION)',
        },
        role: { type: GraphQLString },
        roles: { type: new GraphQLList(GraphQLString) },
        onlyActiveCollectives: {
          type: GraphQLBoolean,
          description: 'Only return memberships for active collectives (that have been approved by the host)',
          defaultValue: false,
        },
        includeIncognito: {
          type: GraphQLBoolean,
          defaultValue: true,
          description:
            'Whether incognito profiles should be included in the result. Only works if requesting user is an admin of the account.',
        },
      },
      resolve(collective, args, req) {
        const where = { MemberCollectiveId: collective.id };
        const roles = args.roles || (args.role && [args.role]);
        if (roles && roles.length > 0) {
          where.role = { [Op.in]: roles };
        }
        const collectiveConditions = {};
        if (args.type) {
          collectiveConditions.type = args.type;
        }
        if (args.onlyActiveCollectives) {
          collectiveConditions.isActive = true;
        }
        if (!args.includeIncognito || !(req.remoteUser?.isAdmin(collective.id) || req.remoteUser?.isRoot())) {
          collectiveConditions.isIncognito = false; // only admins can see incognito profiles
        }
        return models.Member.findAll({
          where,
          limit: args.limit,
          offset: args.offset,
          include: [
            {
              model: models.Collective,
              as: 'collective',
              where: collectiveConditions,
            },
          ],
        });
      },
    },
    contributors: {
      type: new GraphQLList(ContributorType),
      description: 'All the persons and entities that contribute to this organization',
      args: {
        limit: { type: GraphQLInt, defaultValue: 1000 },
        roles: { type: new GraphQLList(ContributorRoleEnum) },
      },
      async resolve(collective, args, req) {
        const contributors = await req.loaders.Contributors.forCollectiveId.load(collective.id);
        return filterContributors(contributors.all, args);
      },
    },
    collectives: {
      type: CollectiveSearchResultsType,
      args: {
        orderBy: { defaultValue: 'name', type: CollectiveOrderFieldType },
        orderDirection: { defaultValue: 'ASC', type: OrderDirectionType },
        expenseStatus: { defaultValue: null, type: GraphQLString },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        isActive: { type: GraphQLBoolean },
        isArchived: { type: GraphQLBoolean },
      },
      async resolve(collective, args) {
        const query = {
          where: { HostCollectiveId: collective.id, type: { [Op.in]: [types.COLLECTIVE, types.FUND] } },
          order: [[args.orderBy, args.orderDirection]],
          limit: args.limit,
          offset: args.offset,
        };

        if (typeof args.isActive !== 'undefined') {
          query.where.isActive = args.isActive;
        } else if (typeof args.isArchived !== 'undefined') {
          query.where.isArchived = args.isArchived;
        }

        /* if any specific Expense status was passed */
        if (args.expenseStatus) {
          /* The escape trick came from here:
             https://github.com/sequelize/sequelize/issues/1132

             Didin't really find a better way to do it. */
          const status = SqlString.escape(args.expenseStatus.toUpperCase());
          query.where.expenseCount = sequelize.where(
            /* This tests if collective has any expenses in the given
             * status. */
            sequelize.literal(
              '(SELECT COUNT("id") FROM "Expenses" WHERE "Expenses"."CollectiveId" =' +
                ` "Collective"."id" AND "status" = ${status})`,
              args.expenseStatus,
            ),
            '>',
            0,
          );
        }
        const result = await models.Collective.findAndCountAll(query);
        const { count, rows } = result;
        return {
          total: count,
          collectives: rows,
          limit: args.limit,
          offset: args.offset,
        };
      },
    },
    followers: {
      type: new GraphQLList(CollectiveInterfaceType),
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve(collective, args) {
        return models.Member.findAll({
          where: { CollectiveId: collective.id, role: roles.FOLLOWER },
          include: [{ model: models.Collective, as: 'memberCollective' }],
          limit: args.limit,
          offset: args.offset,
        }).then(memberships => memberships.memberCollective);
      },
    },
    notifications: {
      type: new GraphQLList(NotificationType),
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        channel: { type: GraphQLString },
        type: { type: GraphQLString },
        active: { type: GraphQLBoolean },
      },
      resolve(collective, args, req) {
        // There's no reason for other people than admins to know about this.
        // Also the webhooks URL are supposed to be private (can contain tokens).
        if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
          return [];
        }

        const where = { CollectiveId: collective.id };

        if (args.channel) {
          where.channel = args.channel;
        }
        if (args.type) {
          where.type = args.type;
        }
        if (args.active) {
          where.active = args.active;
        }

        return models.Notification.findAll({
          where: where,
          limit: args.limit,
          offset: args.offset,
          order: [['createdAt', 'ASC']],
        });
      },
    },
    tiers: {
      type: new GraphQLList(TierType),
      args: {
        id: { type: GraphQLInt },
        slug: { type: GraphQLString },
        slugs: { type: new GraphQLList(GraphQLString) },
      },
      resolve(collective, args) {
        const where = {};

        if (args.id) {
          where.id = args.id;
        } else if (args.slug) {
          where.slug = args.slug;
        } else if (args.slugs && args.slugs.length > 0) {
          where.slug = { [Op.in]: args.slugs };
        }

        return collective.getTiers({
          where,
          order: [['amount', 'ASC']],
        });
      },
    },
    orders: {
      type: new GraphQLList(OrderType),
      args: {
        status: { type: OrderStatusType },
      },
      resolve(collective, args = {}, req) {
        const where = {};

        if (args.status === 'PLEDGED') {
          return req.loaders.Order.findPledgedOrdersForCollective.load(collective.id);
        } else if (args.status) {
          where.status = args.status;
        } else {
          where.processedAt = { [Op.ne]: null };
        }

        return collective.getIncomingOrders({
          where,
          order: [['createdAt', 'DESC']],
        });
      },
    },
    ordersFromCollective: {
      type: new GraphQLList(OrderType),
      args: {
        subscriptionsOnly: { type: GraphQLBoolean },
      },
      resolve(collective, args) {
        const query = {
          where: {}, // TODO: might need a filter of 'processedAt'
          order: [['createdAt', 'DESC']],
        };

        if (args.subscriptionsOnly) {
          query.include = [
            {
              model: models.Subscription,
              required: true,
            },
          ];
        }
        return collective.getOutgoingOrders(query);
      },
    },
    transactions: {
      type: new GraphQLList(TransactionInterfaceType),
      args: {
        type: {
          type: GraphQLString,
          description: 'type of transaction (DEBIT/CREDIT)',
        },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        includeExpenseTransactions: {
          type: GraphQLBoolean,
          default: true,
          description: 'If false, only the transactions not linked to an expense (orders/refunds) will be returned',
        },
      },
      resolve(collective, args) {
        return collective.getTransactions({ ...args, order: [['id', 'DESC']] });
      },
    },
    expenses: {
      type: new GraphQLList(ExpenseType),
      args: {
        type: { type: GraphQLString },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        includeHostedCollectives: { type: GraphQLBoolean },
        status: { type: GraphQLString },
      },
      async resolve(collective, args) {
        const query = { where: {} };
        if (args.status) {
          query.where.status = args.status;
        }
        if (args.limit) {
          query.limit = args.limit;
        }
        if (args.offset) {
          query.offset = args.offset;
        }
        query.order = [['createdAt', 'DESC']];

        let collectiveIds;
        // if is host, we get all the expenses across all the hosted collectives
        if (args.includeHostedCollectives) {
          const members = await models.Member.findAll({
            where: {
              MemberCollectiveId: collective.id,
              role: 'HOST',
            },
          });
          collectiveIds = members.map(members => members.CollectiveId);
        } else {
          collectiveIds = [collective.id];
        }

        query.where.CollectiveId = { [Op.in]: collectiveIds };
        return models.Expense.findAll(query);
      },
    },
    supportedExpenseTypes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      description: 'The list of expense types supported by this account',
      async resolve(collective, _, req) {
        const host =
          collective.HostCollectiveId && (await req.loaders.Collective.byId.load(collective.HostCollectiveId));
        const parent =
          collective.ParentCollectiveId && (await req.loaders.Collective.byId.load(collective.ParentCollectiveId));

        // Aggregate all configs, using the order of priority collective > parent > host
        const getExpenseTypes = account => omitBy(account?.settings?.expenseTypes, isNull);
        const defaultExpenseTypes = { GRANT: false, INVOICE: true, RECEIPT: true };
        const aggregatedConfig = merge(defaultExpenseTypes, ...[host, parent, collective].map(getExpenseTypes));
        return Object.keys(aggregatedConfig).filter(key => aggregatedConfig[key]); // Return only the truthy ones
      },
    },
    role: {
      type: GraphQLString,
      resolve(collective, args, req) {
        return collective.role || collective.getRoleForMemberCollective(req.remoteUser.CollectiveId);
      },
    },
    twitterHandle: {
      type: GraphQLString,
      deprecationReason: '2023-01-16: Please use socialLinks',
      resolve(collective) {
        return collective.twitterHandle;
      },
    },
    githubHandle: {
      type: GraphQLString,
      deprecationReason: '2022-06-03: Please use repositoryUrl',
    },
    repositoryUrl: {
      type: GraphQLString,
      description: 'The URL of the repository',
      deprecationReason: '2023-01-16: Please use socialLinks',
    },
    website: {
      type: GraphQLString,
      deprecationReason: '2023-01-16: Please use socialLinks',
      resolve(collective) {
        return collective.website;
      },
    },
    socialLinks: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SocialLink))),
      async resolve(collective, _, req) {
        return req.loaders.SocialLink.byCollectiveId.load(collective.id);
      },
    },
    updates: {
      type: new GraphQLList(UpdateType),
      deprecationReason: '2022-09-09: Updates moved to GQLV2',
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        onlyPublishedUpdates: { type: GraphQLBoolean },
      },
      resolve(collective, args) {
        const query = { where: { CollectiveId: collective.id }, order: [['createdAt', 'DESC']] };
        if (args.limit) {
          query.limit = args.limit;
        }
        if (args.offset) {
          query.offset = args.offset;
        }
        if (args.onlyPublishedUpdates) {
          query.where.publishedAt = { [Op.ne]: null };
        }
        return models.Update.findAll(query);
      },
    },
    events: {
      type: new GraphQLList(EventCollectiveType),
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        includePastEvents: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Include past events',
        },
        includeInactive: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Include inactive events',
        },
      },
      resolve(collective, args) {
        const query = { where: {} };

        if (args.limit) {
          query.limit = args.limit;
        }
        if (args.offset) {
          query.offset = args.offset;
        }
        if (!args.includeInactive) {
          query.where.isActive = true;
        }
        if (!args.includePastEvents) {
          // Use midnight so we only mark events as passed the day after
          const today = new Date().setHours(0, 0, 0, 0);
          query.where = {
            [Op.and]: [
              // Include all previous conditions
              query.where,
              // An event is not passed if end date is in the future OR if end date
              // is not set but start date is in the past OR if there's no start date
              // nor end date
              {
                [Op.or]: [
                  { startsAt: null, endsAt: null },
                  { endsAt: { [Op.gte]: Date.now() } },
                  { endsAt: null, startsAt: { [Op.gte]: today } },
                ],
              },
            ],
          };
        }

        return collective.getEvents(args);
      },
    },
    projects: {
      type: new GraphQLList(ProjectCollectiveType),
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
      },
      resolve(collective, args) {
        return collective.getProjects(args);
      },
    },
    paymentMethods: {
      type: new GraphQLList(PaymentMethodType),
      args: {
        service: { type: GraphQLString },
        limit: { type: GraphQLInt },
        hasBalanceAboveZero: { type: GraphQLBoolean },
        isConfirmed: { type: GraphQLBoolean, defaultValue: true },
        type: { type: new GraphQLList(GraphQLString) },
        orderBy: {
          type: PaymentMethodOrderFieldType,
          defaultValue: 'type',
        },
        includeHostCollectivePaymentMethod: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'Defines if the host "collective" payment method should be returned',
        },
      },
      async resolve(collective, args, req) {
        if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
          return [];
        }
        let paymentMethods = await req.loaders.PaymentMethod.findByCollectiveId.load(collective.id);
        // Filter Payment Methods used by Hosts for "Add Funds"
        if (
          !args.includeHostCollectivePaymentMethod &&
          (collective.type === 'ORGANIZATION' || collective.type === 'USER')
        ) {
          paymentMethods = paymentMethods.filter(pm => !(pm.service === 'opencollective' && pm.type === 'host'));
        }
        // Filter only "saved" stripe Payment Methods
        // In the future we should only return the "saved" whatever the service
        paymentMethods = paymentMethods.filter(pm => pm.service !== 'stripe' || pm.saved);

        paymentMethods = paymentMethods.filter(pm => !(pm.data && pm.data.hidden));

        if (args.service) {
          paymentMethods = paymentMethods.filter(pm => pm.service === args.service.toLowerCase());
        }
        if (args.type) {
          paymentMethods = paymentMethods.filter(pm => args.type.map(t => t.toLowerCase()).includes(pm.type));
        }
        if (args.isConfirmed !== undefined) {
          paymentMethods = paymentMethods.filter(pm => pm.isConfirmed() === args.isConfirmed);
        }
        if (args.hasBalanceAboveZero) {
          const filteredArray = [];
          for (const paymentMethod of paymentMethods) {
            const balance = await paymentMethod.getBalanceForUser(req.remoteUser);
            if (balance.amount > 0) {
              filteredArray.push(paymentMethod);
            }
            if (args.limit && filteredArray.length >= args.limit) {
              break;
            }
          }
          paymentMethods = filteredArray;
        }
        if (args.limit) {
          paymentMethods = paymentMethods.slice(0, args.limit);
        }
        if (args.orderBy) {
          paymentMethods = sortBy(paymentMethods, args.orderBy);
        }

        const now = new Date();
        return paymentMethods.filter(pm => !pm.expiryDate || pm.expiryDate > now);
      },
    },
    payoutMethods: {
      type: new GraphQLList(PayoutMethodType),
      description: 'The list of payout methods that this collective can use to get paid',
      async resolve(collective, _, req) {
        if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
          return null;
        } else {
          return req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
        }
      },
    },
    giftCardsBatches: {
      type: new GraphQLList(PaymentMethodBatchInfo),
      description:
        'List all the gift cards batches emitted by this collective. May include `null` for unbatched gift cards.',
      resolve: async (collective, _args, req) => {
        // Must be admin of the collective
        if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
          return [];
        }

        return queries.getGiftCardBatchesForCollective(collective.id);
      },
    },
    createdGiftCards: {
      type: PaginatedPaymentMethodsType,
      description: 'Get the gift cards created by this collective. RemoteUser must be a collective admin.',
      args: {
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        batch: { type: GraphQLString },
        isConfirmed: {
          type: GraphQLBoolean,
          description: 'Whether the gift card has been claimed or not',
        },
      },
      resolve: async (collective, args, req) => {
        // Must be admin of the collective
        if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
          return [];
        }

        const offset = args.offset || 0;
        const limit = args.limit || 15;
        const query = {
          where: { type: PAYMENT_METHOD_TYPE.GIFTCARD, service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE },
          limit: args.limit,
          offset: args.offset,
          order: [
            ['createdAt', 'DESC'],
            ['id', 'DESC'],
          ],
          include: [
            {
              model: models.PaymentMethod,
              as: 'sourcePaymentMethod',
              where: { CollectiveId: collective.id },
              required: true,
              attributes: [],
            },
          ],
        };

        if (args.isConfirmed !== undefined) {
          query.where.confirmedAt = { [args.isConfirmed ? Op.ne : Op.eq]: null };
        }

        if (args.batch !== undefined) {
          query.where.batch = args.batch;
        }

        const result = await models.PaymentMethod.findAndCountAll(query);

        return {
          paymentMethods: result.rows,
          total: result.count,
          limit,
          offset,
        };
      },
    },
    connectedAccounts: {
      type: new GraphQLList(ConnectedAccountType),
      resolve(collective, args, req) {
        return req.loaders.Collective.connectedAccounts.load(collective.id);
      },
    },
    features: {
      type: new GraphQLNonNull(CollectiveFeatures),
      description: 'Describes the features enabled and available for this collective',
      resolve: collective => collective,
    },
    plan: {
      type: PlanType,
      resolve(collective) {
        return collective.getPlan();
      },
    },
    stats: {
      type: CollectiveStatsType,
      resolve(collective) {
        return collective;
      },
    },
    contributionPolicy: {
      type: GraphQLString,
      resolve(collective) {
        return collective.contributionPolicy;
      },
    },
    categories: {
      type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
      resolve(collective) {
        return get(collective.data, 'categories', []);
      },
    },
    policies: {
      type: new GraphQLNonNull(Policies),
      resolve(account) {
        return account;
      },
    },
  };
};

export const CollectiveFeatureStatus = new GraphQLEnumType({
  name: 'CollectiveFeatureStatus',
  values: {
    [FEATURE_STATUS.ACTIVE]: {
      description: 'The feature is enabled and is actively used',
    },
    [FEATURE_STATUS.AVAILABLE]: {
      description: 'The feature is enabled, but there is no data for it',
    },
    [FEATURE_STATUS.DISABLED]: {
      description: 'The feature is disabled, but can be enabled by an admin',
    },
    [FEATURE_STATUS.UNSUPPORTED]: {
      description: 'The feature is disabled and cannot be activated for this account',
    },
  },
});

export const CollectiveFeatures = new GraphQLObjectType({
  name: 'CollectiveFeatures',
  description: 'Describes the features enabled and available for this account',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The id of the account',
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACCOUNT),
      },
      ...FeaturesFields(),
    };
  },
});

export const CollectiveType = new GraphQLObjectType({
  name: 'Collective',
  description: 'This represents a Collective',
  interfaces: [CollectiveInterfaceType],
  fields: CollectiveFields,
});

export const UserCollectiveType = new GraphQLObjectType({
  name: 'User',
  description: 'This represents a User Collective',
  interfaces: [CollectiveInterfaceType],
  fields: () => {
    return {
      ...CollectiveFields(),
      email: {
        type: GraphQLString,
        async resolve(userCollective, args, req) {
          if (!req.remoteUser) {
            return null;
          } else {
            const user = await (userCollective.isIncognito
              ? req.loaders.User.byId.load(userCollective.CreatedByUserId) // TODO: Should rely on Member
              : req.loaders.User.byCollectiveId.load(userCollective.id));

            if (user && (await req.loaders.Collective.canSeePrivateInfo.load(user.CollectiveId))) {
              return user.email;
            }
          }
        },
      },
      applications: {
        type: new GraphQLList(ApplicationType),
        resolve(userCollective, _, req) {
          if (req.remoteUser && req.remoteUser.isAdmin(userCollective.id)) {
            return models.Application.findAll({
              where: { CollectiveId: userCollective.id },
            });
          }
        },
      },
    };
  },
});

export const OrganizationCollectiveType = new GraphQLObjectType({
  name: 'Organization',
  description: 'This represents a Organization Collective',
  interfaces: [CollectiveInterfaceType],
  fields: () => {
    return {
      ...CollectiveFields(),
      email: {
        type: GraphQLString,
        deprecationReason: '2022-07-18: This field is deprecated and will return null',
        resolve: () => null,
      },
    };
  },
});

export const EventCollectiveType = new GraphQLObjectType({
  name: 'Event',
  description: 'This represents an Event',
  interfaces: [CollectiveInterfaceType],
  fields: CollectiveFields,
});

export const ProjectCollectiveType = new GraphQLObjectType({
  name: 'Project',
  description: 'This represents a Project',
  interfaces: [CollectiveInterfaceType],
  fields: CollectiveFields,
});

export const FundCollectiveType = new GraphQLObjectType({
  name: 'Fund',
  description: 'This represents a Fund',
  interfaces: [CollectiveInterfaceType],
  fields: CollectiveFields,
});

export const VendorCollectiveType = new GraphQLObjectType({
  name: 'Vendor',
  description: 'This represents a Vendor',
  interfaces: [CollectiveInterfaceType],
  fields: CollectiveFields,
});

export const CollectiveSearchResultsType = new GraphQLObjectType({
  name: 'CollectiveSearchResults',
  description: 'The results from searching for collectives with pagination info',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'A unique identifier for this search (for caching)',
    },
    collectives: {
      type: new GraphQLList(CollectiveType),
    },
    limit: {
      type: GraphQLInt,
    },
    offset: {
      type: GraphQLInt,
    },
    total: {
      type: GraphQLInt,
    },
  }),
});
