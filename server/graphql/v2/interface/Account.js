import { GraphQLBoolean, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import GraphQLJSON from 'graphql-type-json';
import { assign, get, invert } from 'lodash';

import models, { Op } from '../../../models';
import { NotFound } from '../../errors';
import { CollectiveFeatures } from '../../v1/CollectiveInterface.js';
import { ConversationCollection } from '../collection/ConversationCollection';
import { MemberCollection, MemberOfCollection } from '../collection/MemberCollection';
import { OrderCollection } from '../collection/OrderCollection';
import { TransactionCollection } from '../collection/TransactionCollection';
import { UpdateCollection } from '../collection/UpdateCollection';
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
import { AccountReferenceInput } from '../input/AccountReferenceInput';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { HasMembersFields } from '../interface/HasMembers';
import { IsMemberOfFields } from '../interface/IsMemberOf';
import { AccountStats } from '../object/AccountStats';
import { ConnectedAccount } from '../object/ConnectedAccount';
import { Location } from '../object/Location';
import { PaymentMethod } from '../object/PaymentMethod';
import PayoutMethod from '../object/PayoutMethod';
import { TagStats } from '../object/TagStats';
import { TransferWise } from '../object/TransferWise';
import EmailAddress from '../scalar/EmailAddress';

import { CollectionArgs } from './Collection';

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
  isIncognito: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Defines if the contributors wants to be incognito (name not displayed)',
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
  backgroundImageUrl: {
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
      email: {
        type: EmailAddress,
        description: 'Admin only. To filter on the email address of a member, useful to check if a member exists.',
      },
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
      isApproved: {
        type: GraphQLBoolean,
        description: 'Filter on (un)approved collectives',
      },
      isArchived: {
        type: GraphQLBoolean,
        description: 'Filter on archived collectives',
      },
      accountType: {
        type: new GraphQLList(AccountType),
        description: 'Type of accounts (BOT/COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL)',
      },
      account: {
        type: AccountReferenceInput,
        description: 'Specific account to query the membership of.',
      },
      orderBy: {
        type: new GraphQLNonNull(ChronologicalOrderInput),
        defaultValue: ChronologicalOrderInput.defaultValue,
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
      includeIncognitoTransactions: {
        type: new GraphQLNonNull(GraphQLBoolean),
        defaultValue: false,
        description:
          'If the account is a user and this field is true, contributions from the incognito profile will be included too (admins only)',
      },
    },
  },
  orders: {
    type: new GraphQLNonNull(OrderCollection),
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
    description: 'The list of payout methods that this account can use to get paid',
  },
  paymentMethods: {
    type: new GraphQLList(PaymentMethod),
    description: 'The list of payment methods that this account can use to pay for Orders',
    args: {
      types: {
        type: new GraphQLList(GraphQLString),
        description: 'Filter on given types (creditcard, giftcard...)',
      },
      includeExpired: {
        type: GraphQLBoolean,
        description:
          'Wether to include expired payment methods. Payment methods expired since more than 6 months will never be returned.',
      },
    },
  },
  connectedAccounts: {
    type: new GraphQLList(ConnectedAccount),
    description: 'The list of connected accounts (Stripe, Twitter, etc ...)',
  },
  location: {
    type: Location,
    description: 'The address associated to this account. This field is always public for collectives and events.',
  },
  categories: {
    type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
    description: 'Categories set by Open Collective to help moderation.',
  },
  stats: {
    type: AccountStats,
    resolve(collective) {
      return collective;
    },
  },
  updates: {
    type: new GraphQLNonNull(UpdateCollection),
    args: {
      ...CollectionArgs,
      onlyPublishedUpdates: { type: GraphQLBoolean },
    },
    async resolve(collective, { limit, offset, onlyPublishedUpdates }) {
      let where = {
        CollectiveId: collective.id,
      };
      if (onlyPublishedUpdates) {
        where = assign(where, { publishedAt: { [Op.ne]: null } });
      }
      const query = {
        where,
        order: [['createdAt', 'DESC']],
        limit,
        offset,
      };

      const result = await models.Update.findAndCountAll(query);
      return { nodes: result.rows, totalCount: result.count, limit, offset };
    },
  },
  features: {
    type: new GraphQLNonNull(CollectiveFeatures),
    description: 'Describes the features enabled and available for this collective',
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
  type: new GraphQLNonNull(TransactionCollection),
  args: {
    type: { type: TransactionType },
    limit: { type: GraphQLInt, defaultValue: 100 },
    offset: { type: GraphQLInt, defaultValue: 0 },
    orderBy: {
      type: ChronologicalOrderInput,
      defaultValue: ChronologicalOrderInput.defaultValue,
    },
    includeIncognitoTransactions: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: false,
      description:
        'If the account is a user and this field is true, contributions from the incognito profile will be included too (admins only)',
    },
  },
  async resolve(collective, args, req) {
    const where = { CollectiveId: collective.id };

    // When users are admins, also fetch their incognito contributions
    if (args.includeIncognitoTransactions && req.remoteUser?.isAdminOfCollective(collective)) {
      const incognitoProfile = await req.remoteUser.getIncognitoProfile();
      if (incognitoProfile) {
        where.CollectiveId = { [Op.or]: [collective.id, incognitoProfile.id] };
      }
    }

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
  type: new GraphQLNonNull(OrderCollection),
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

    // Pagination
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
  backgroundImageUrl: {
    type: GraphQLString,
    args: {
      height: { type: GraphQLInt },
      format: {
        type: ImageFormat,
      },
    },
    resolve(collective, args) {
      return collective.getBackgroundImageUrl(args);
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
      if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
        return null;
      } else {
        return req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
      }
    },
  },
  paymentMethods: {
    type: new GraphQLNonNull(new GraphQLList(PaymentMethod)),
    args: {
      // TODO: Should filter by providerType
      types: { type: new GraphQLList(GraphQLString) },
      includeExpired: {
        type: GraphQLBoolean,
        description:
          'Wether to include expired payment methods. Payment methods expired since more than 6 months will never be returned.',
      },
    },
    description: 'The list of payment methods that this collective can use to pay for Orders',
    async resolve(collective, args, req) {
      const now = new Date();
      const paymentMethods = await req.loaders.PaymentMethod.findByCollectiveId.load(collective.id);

      return paymentMethods.filter(pm => {
        if (args.types && !args.types.includes(pm.type)) {
          return false;
        } else if (pm.data?.hidden) {
          return false;
        } else if (pm.service === 'stripe' && !pm.saved) {
          return false;
        } else if (!args.includeExpired && pm.expiryDate && pm.expiryDate <= now) {
          return false;
          // Exclude unclaimed Gift Cards
        } else if (pm.type === 'giftcard' && !pm.confirmedAt) {
          return false;
        } else {
          return true;
        }
      });
    },
  },
  connectedAccounts: {
    type: new GraphQLList(ConnectedAccount),
    description: 'The list of connected accounts (Stripe, Twitter, etc ...)',
    // Only for admins, no pagination
    async resolve(collective, _, req) {
      if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(collective)) {
        return null;
      } else {
        return req.loaders.Collective.connectedAccounts.load(collective.id);
      }
    },
  },
  categories: {
    type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
    resolve(collective) {
      return get(collective.data, 'categories', []);
    },
  },
};

export default Account;
