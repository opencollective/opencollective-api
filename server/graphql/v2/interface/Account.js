import { GraphQLBoolean, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import GraphQLJSON from 'graphql-type-json';
import { invert } from 'lodash';

import models, { Op } from '../../../models';
import { hostResolver } from '../../common/collective';
import { NotFound } from '../../errors';
import { ConversationCollection } from '../collection/ConversationCollection';
import { MemberCollection, MemberOfCollection } from '../collection/MemberCollection';
import { OrderCollection } from '../collection/OrderCollection';
import { TierCollection } from '../collection/TierCollection';
import { TransactionCollection } from '../collection/TransactionCollection';
import {
  AccountOrdersFilter,
  AccountType,
  AccountTypeToModelMapping,
  ImageFormat,
  MemberRole,
  OrderStatus,
  TransactionType,
} from '../enum';
import { idEncode } from '../identifiers';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { HasMembersFields } from '../interface/HasMembers';
import { IsMemberOfFields } from '../interface/IsMemberOf';
import { AccountStats } from '../object/AccountStats';
import { ConnectedAccount } from '../object/ConnectedAccount';
import { Host } from '../object/Host';
import { Location } from '../object/Location';
import { PaymentMethod } from '../object/PaymentMethod';
import PayoutMethod from '../object/PayoutMethod';
import { TagStats } from '../object/TagStats';
import { TransferWise } from '../object/TransferWise';

const accountFieldsDefinition = () => ({
  id: {
    type: GraphQLString,
    description: 'The public id identifying the account (ie: 5v08jk63-w4g9nbpz-j7qmyder-p7ozax5g)',
  },
  legacyId: {
    type: GraphQLInt,
    description: 'The internal database identifier of the collective (ie: 580)',
    deprecationReason: '2020-01-01: should only be used during the transition to GraphQL API v2.',
  },
  slug: {
    type: GraphQLString,
    description: 'The slug identifying the account (ie: babel)',
  },
  type: {
    type: AccountType,
    description: 'The type of the account (BOT/COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL)',
  },
  name: {
    type: GraphQLString,
  },
  description: {
    type: GraphQLString,
  },
  longDescription: {
    type: GraphQLString,
  },
  tags: {
    type: new GraphQLList(GraphQLString),
  },
  website: {
    type: GraphQLString,
  },
  twitterHandle: {
    type: GraphQLString,
  },
  githubHandle: {
    type: GraphQLString,
  },
  currency: {
    type: GraphQLString,
  },
  expensePolicy: {
    type: GraphQLString,
  },
  imageUrl: {
    type: GraphQLString,
    args: {
      height: { type: GraphQLInt },
      format: {
        type: ImageFormat,
      },
    },
  },
  createdAt: {
    type: GraphQLDateTime,
    description: 'The time of creation',
  },
  updatedAt: {
    type: GraphQLDateTime,
    description: 'The time of last update',
  },
  isArchived: {
    type: GraphQLBoolean,
    description: 'Returns whether this account is archived',
  },
  isActive: {
    type: GraphQLBoolean,
    description: 'Returns whether the account accepts financial contributions.',
  },
  isHost: {
    type: GraphQLBoolean,
    description: 'Returns whether the account is setup to Host collectives.',
  },
  isAdmin: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns true if the remote user is an admin of this account',
  },
  members: {
    type: MemberCollection,
    args: {
      limit: { type: GraphQLInt, defaultValue: 100 },
      offset: { type: GraphQLInt, defaultValue: 0 },
      role: { type: new GraphQLList(MemberRole) },
      accountType: {
        type: new GraphQLList(AccountType),
        description: 'Type of accounts (BOT/COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL)',
      },
    },
  },
  memberOf: {
    type: MemberOfCollection,
    args: {
      limit: { type: GraphQLInt, defaultValue: 100 },
      offset: { type: GraphQLInt, defaultValue: 0 },
      role: { type: new GraphQLList(MemberRole) },
      accountType: {
        type: new GraphQLList(AccountType),
        description: 'Type of accounts (BOT/COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL)',
      },
    },
  },
  transactions: {
    type: TransactionCollection,
    args: {
      limit: { type: GraphQLInt, defaultValue: 100 },
      offset: { type: GraphQLInt, defaultValue: 0 },
      type: {
        type: TransactionType,
        description: 'Type of transaction (DEBIT/CREDIT)',
      },
      orderBy: {
        type: ChronologicalOrderInput,
      },
    },
  },
  orders: {
    type: OrderCollection,
    args: {
      limit: { type: GraphQLInt, defaultValue: 100 },
      offset: { type: GraphQLInt, defaultValue: 0 },
      filter: { type: AccountOrdersFilter },
      status: { type: new GraphQLList(OrderStatus) },
      tierSlug: { type: GraphQLString },
      onlySubscriptions: {
        type: GraphQLBoolean,
        description: 'Only returns orders that have an subscription (monthly/yearly)',
      },
      orderBy: {
        type: ChronologicalOrderInput,
      },
    },
  },
  settings: {
    type: new GraphQLNonNull(GraphQLJSON),
  },
  conversations: {
    type: ConversationCollection,
    args: {
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      tag: {
        type: GraphQLString,
        description: 'Only return conversations matching this tag',
      },
    },
  },
  conversationsTags: {
    type: new GraphQLList(TagStats),
    description: "Returns conversation's tags for collective sorted by popularity",
    args: {
      limit: { type: GraphQLInt, defaultValue: 30 },
    },
  },
  expensesTags: {
    type: new GraphQLList(TagStats),
    description: 'Returns expense tags for collective sorted by popularity',
    args: {
      limit: { type: GraphQLInt, defaultValue: 30 },
    },
  },
  transferwise: {
    type: TransferWise,
    async resolve(collective) {
      const connectedAccount = await models.ConnectedAccount.findOne({
        where: { service: 'transferwise', CollectiveId: collective.id },
      });
      if (connectedAccount) {
        return collective;
      } else {
        return null;
      }
    },
  },
  payoutMethods: {
    type: new GraphQLList(PayoutMethod),
    description: 'The list of payout methods that this collective can use to get paid',
  },
  paymentMethods: {
    type: new GraphQLList(PaymentMethod),
    args: {
      types: {
        type: new GraphQLList(GraphQLString),
        description: 'Filter on given types (creditcard, virtualcard...)',
      },
    },
    description: 'The list of payment methods that this collective can use to pay for Orders',
  },
  connectedAccounts: {
    type: new GraphQLList(ConnectedAccount),
    description: 'The list of connected accounts (Stripe, Twitter, etc ...)',
  },
  location: {
    type: Location,
    description: 'The address associated to this account. This field is always public for collectives and events.',
  },
  stats: {
    type: AccountStats,
    resolve(collective) {
      return collective;
    },
  },
});

export const Account = new GraphQLInterfaceType({
  name: 'Account',
  description: 'Account interface shared by all kind of accounts (Bot, Collective, Event, User, Organization)',
  fields: accountFieldsDefinition,
});

const accountTransactions = {
  type: TransactionCollection,
  args: {
    type: { type: TransactionType },
    limit: { type: GraphQLInt, defaultValue: 100 },
    offset: { type: GraphQLInt, defaultValue: 0 },
    orderBy: {
      type: ChronologicalOrderInput,
      defaultValue: ChronologicalOrderInput.defaultValue,
    },
  },
  async resolve(collective, args) {
    const where = { CollectiveId: collective.id };

    if (args.type) {
      where.type = args.type;
    }

    const result = await models.Transaction.findAndCountAll({
      where,
      limit: args.limit,
      offset: args.offset,
      order: [[args.orderBy.field, args.orderBy.direction]],
    });

    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

const accountOrders = {
  type: OrderCollection,
  args: {
    limit: { type: GraphQLInt, defaultValue: 100 },
    offset: { type: GraphQLInt, defaultValue: 0 },
    filter: { type: AccountOrdersFilter },
    status: { type: new GraphQLList(OrderStatus) },
    tierSlug: { type: GraphQLString },
    onlySubscriptions: {
      type: GraphQLBoolean,
      description: 'Only returns orders that have an subscription (monthly/yearly)',
    },
    orderBy: {
      type: ChronologicalOrderInput,
      defaultValue: ChronologicalOrderInput.defaultValue,
    },
  },
  async resolve(collective, args) {
    let where, include;
    if (args.filter === 'OUTGOING') {
      where = { FromCollectiveId: collective.id };
    } else if (args.filter === 'INCOMING') {
      where = { CollectiveId: collective.id };
    } else {
      where = { [Op.or]: { CollectiveId: collective.id, FromCollectiveId: collective.id } };
    }

    if (args.status && args.status.length > 0) {
      where.status = { [Op.in]: args.status };
    }

    if (args.tierSlug) {
      const tierSlug = args.tierSlug.toLowerCase();
      const tier = await models.Tier.findOne({ where: { CollectiveId: collective.id, slug: tierSlug } });
      if (!tier) {
        throw new NotFound('TierSlug Not Found');
      }
      where.TierId = tier.id;
    }

    if (args.limit <= 0 || args.limit > 1000) {
      args.limit = 100;
    }
    if (args.offset <= 0) {
      args.offset = 0;
    }

    if (args.onlySubscriptions) {
      include = [{ model: models.Subscription, required: true }];
    }

    const result = await models.Order.findAndCountAll({
      where,
      include,
      limit: args.limit,
      offset: args.offset,
      order: [[args.orderBy.field, args.orderBy.direction]],
    });

    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

export const AccountFields = {
  ...accountFieldsDefinition(),
  id: {
    type: GraphQLString,
    resolve(collective) {
      return idEncode(collective.id, 'account');
    },
  },
  legacyId: {
    type: GraphQLInt,
    resolve(collective) {
      return collective.id;
    },
  },
  type: {
    type: AccountType,
    resolve(collective) {
      return invert(AccountTypeToModelMapping)[collective.type];
    },
  },
  imageUrl: {
    type: GraphQLString,
    args: {
      height: { type: GraphQLInt },
      format: {
        type: ImageFormat,
      },
    },
    resolve(collective, args) {
      return collective.getImageUrl(args);
    },
  },
  updatedAt: {
    type: GraphQLDateTime,
    resolve(collective) {
      return collective.updatedAt || collective.createdAt;
    },
  },
  isArchived: {
    type: GraphQLBoolean,
    description: 'Returns whether this account is archived',
    resolve(collective) {
      return Boolean(collective.deactivatedAt);
    },
  },
  isHost: {
    type: GraphQLBoolean,
    description: 'Returns whether the account is setup to Host collectives.',
    resolve(collective) {
      return Boolean(collective.isHostAccount);
    },
  },
  isAdmin: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns true if the remote user is an admin of this account',
    resolve(collective, _, req) {
      return Boolean(req.remoteUser?.isAdminOfCollective(collective));
    },
  },
  ...HasMembersFields,
  ...IsMemberOfFields,
  transactions: accountTransactions,
  orders: accountOrders,
  conversations: {
    type: ConversationCollection,
    args: {
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      tag: {
        type: GraphQLString,
        description: 'Only return conversations matching this tag',
      },
    },
    async resolve(collective, { limit, offset, tag }) {
      const query = { where: { CollectiveId: collective.id }, order: [['createdAt', 'DESC']] };
      if (limit) {
        query.limit = limit;
      }
      if (offset) {
        query.offset = offset;
      }
      if (tag) {
        query.where.tags = { [Op.contains]: [tag] };
      }
      const result = await models.Conversation.findAndCountAll(query);
      return { nodes: result.rows, totalCount: result.count, limit, offset };
    },
  },
  conversationsTags: {
    type: new GraphQLList(TagStats),
    description: "Returns conversation's tags for collective sorted by popularity",
    args: {
      limit: { type: GraphQLInt, defaultValue: 30 },
    },
    async resolve(collective, _, { limit }) {
      return models.Conversation.getMostPopularTagsForCollective(collective.id, limit);
    },
  },
  expensesTags: {
    type: new GraphQLList(TagStats),
    description: 'Returns expense tags for collective sorted by popularity',
    args: {
      limit: { type: GraphQLInt, defaultValue: 30 },
    },
    async resolve(collective, _, { limit }) {
      return models.Expense.getMostPopularExpenseTagsForCollective(collective.id, limit);
    },
  },
  payoutMethods: {
    type: new GraphQLList(PayoutMethod),
    description: 'The list of payout methods that this collective can use to get paid',
    async resolve(collective, _, req) {
      if (!req.remoteUser || !req.remoteUser.isAdmin(collective.id)) {
        return null;
      } else {
        return req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
      }
    },
  },
  paymentMethods: {
    type: new GraphQLList(PaymentMethod),
    args: {
      types: { type: new GraphQLList(GraphQLString) },
    },
    description: 'The list of payment methods that this collective can use to pay for Orders',
    async resolve(collective, args, req) {
      let paymentMethods = await req.loaders.PaymentMethod.findByCollectiveId.load(collective.id);

      // Filter only "saved" stripe Payment Methods
      paymentMethods = paymentMethods.filter(pm => pm.service !== 'stripe' || pm.saved);

      paymentMethods = paymentMethods.filter(pm => !(pm.data && pm.data.hidden));

      if (args.types) {
        paymentMethods = paymentMethods.filter(pm => args.types.includes(pm.type));
      }

      return paymentMethods;
    },
  },
  connectedAccounts: {
    type: new GraphQLList(ConnectedAccount),
    description: 'The list of connected accounts (Stripe, Twitter, etc ...)',
    // Only for admins, no pagination
    async resolve(collective, _, req) {
      if (!req.remoteUser || !req.remoteUser.isAdmin(collective.id)) {
        return null;
      } else {
        return req.loaders.Collective.connectedAccounts.load(collective.id);
      }
    },
  },
};

export const CollectiveAndFundFields = {
  balance: {
    description: 'Amount of money in cents in the currency of the account currently available to spend',
    deprecationReason: '2020/04/09 - Should not have been introduced. Use stats.balance.value',
    type: GraphQLInt,
    resolve(account, _, req) {
      return req.loaders.Collective.balance.load(account.id);
    },
  },
  host: {
    description: 'Returns the Fiscal Host',
    type: Host,
    resolve: hostResolver,
  },
  approvedAt: {
    description: 'Date of approval by the Fiscal Host.',
    type: GraphQLDateTime,
    resolve(account) {
      return account.approvedAt;
    },
  },
  isApproved: {
    description: "Returns whether it's approved by the Fiscal Host",
    type: GraphQLBoolean,
    resolve(account) {
      return account.isApproved();
    },
  },
  isActive: {
    description: "Returns whether it's active: can accept financial contributions and pay expenses.",
    type: GraphQLBoolean,
    resolve(account) {
      return Boolean(account.isActive);
    },
  },
  totalFinancialContributors: {
    description: 'Number of unique financial contributors.',
    type: GraphQLInt,
    args: {
      accountType: {
        type: AccountType,
        description: 'Type of account (COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL)',
      },
    },
    async resolve(account, args, req) {
      const stats = await req.loaders.Collective.stats.backers.load(account.id);
      if (!args.accountType) {
        return stats.all;
      } else if (args.accountType === 'INDIVIDUAL') {
        return stats.USER || 0;
      } else {
        return stats[args.accountType] || 0;
      }
    },
  },
  tiers: {
    type: new GraphQLNonNull(TierCollection),
    async resolve(account) {
      const query = { where: { CollectiveId: account.id }, order: [['amount', 'ASC']] };
      const result = await models.Tier.findAndCountAll(query);
      return { nodes: result.rows, totalCount: result.count };
    },
  },
};

export const EventAndProjectFields = {
  balance: {
    description: 'Amount of money in cents in the currency of the account currently available to spend',
    deprecationReason: '2020/04/09 - Should not have been introduced. Use stats.balance.value',
    type: GraphQLInt,
    resolve(account, _, req) {
      return req.loaders.Collective.balance.load(account.id);
    },
  },
  host: {
    description: 'Returns the Fiscal Host',
    type: Host,
    resolve: hostResolver,
  },
  isApproved: {
    description: "Returns whether it's approved by the Fiscal Host",
    type: GraphQLBoolean,
    async resolve(account, _, req) {
      if (!account.ParentCollectiveId) {
        return false;
      } else {
        const parent = await req.loaders.Collective.byId.load(account.ParentCollectiveId);
        return parent && parent.isApproved();
      }
    },
  },
  isActive: {
    description: "Returns whether it's active: can accept financial contributions and pay expenses.",
    type: GraphQLBoolean,
    resolve(account) {
      return Boolean(account.isActive);
    },
  },
};

export default Account;
