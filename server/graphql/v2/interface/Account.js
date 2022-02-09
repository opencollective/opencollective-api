import { GraphQLBoolean, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-type-json';
import { assign, get, invert, isEmpty } from 'lodash';

import { types as CollectiveTypes } from '../../../constants/collectives';
import { canSeeLegalName } from '../../../lib/user-permissions';
import models, { Op } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { allowContextPermission, getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { BadRequest, NotFound, Unauthorized } from '../../errors';
import { CollectiveFeatures } from '../../v1/CollectiveInterface.js';
import { AccountCollection } from '../collection/AccountCollection';
import { ConversationCollection } from '../collection/ConversationCollection';
import { MemberCollection, MemberOfCollection } from '../collection/MemberCollection';
import { OrderCollection } from '../collection/OrderCollection';
import { TransactionCollection } from '../collection/TransactionCollection';
import { UpdateCollection } from '../collection/UpdateCollection';
import { VirtualCardCollection } from '../collection/VirtualCardCollection';
import {
  AccountOrdersFilter,
  AccountType,
  AccountTypeToModelMapping,
  ImageFormat,
  MemberRole,
  OrderStatus,
  TransactionType,
} from '../enum';
import { PaymentMethodService } from '../enum/PaymentMethodService';
import { PaymentMethodType } from '../enum/PaymentMethodType';
import { Policy } from '../enum/Policy';
import { idEncode } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { ORDER_BY_PSEUDO_FIELDS, OrderByInput } from '../input/OrderByInput';
import { AccountStats } from '../object/AccountStats';
import { ConnectedAccount } from '../object/ConnectedAccount';
import { Location } from '../object/Location';
import { PaymentMethod } from '../object/PaymentMethod';
import PayoutMethod from '../object/PayoutMethod';
import { TagStats } from '../object/TagStats';
import { TransferWise } from '../object/TransferWise';
import EmailAddress from '../scalar/EmailAddress';

import { CollectionArgs } from './Collection';
import { HasMembersFields } from './HasMembers';
import { IsMemberOfFields } from './IsMemberOf';

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
    description: 'The type of the account (BOT/COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL/VENDOR)',
  },
  name: {
    type: GraphQLString,
    description: 'Public name',
  },
  legalName: {
    type: GraphQLString,
    description: 'Private, legal name. Used for expense receipts, taxes, etc.',
    resolve: (account, _, req) => {
      if (
        canSeeLegalName(req.remoteUser, account) ||
        getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_LEGAL_NAME, account.id)
      ) {
        return account.legalName;
      } else {
        return null;
      }
    },
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
  parentAccount: {
    type: Account,
    async resolve(collective, _, req) {
      if (!collective.ParentCollectiveId) {
        return null;
      } else {
        return req.loaders.Collective.byId.load(collective.ParentCollectiveId);
      }
    },
  },
  members: {
    type: new GraphQLNonNull(MemberCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
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
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
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
        type: new GraphQLNonNull(OrderByInput),
        defaultValue: { field: ORDER_BY_PSEUDO_FIELDS.CREATED_AT, direction: 'DESC' },
      },
      orderByRoles: {
        type: GraphQLBoolean,
        description: 'Order the query by requested role order',
      },
    },
  },
  transactions: {
    type: new GraphQLNonNull(TransactionCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
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
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
      filter: { type: AccountOrdersFilter },
      status: { type: new GraphQLList(OrderStatus) },
      tierSlug: { type: GraphQLString },
      onlySubscriptions: {
        type: GraphQLBoolean,
        description: 'Only returns orders that have an subscription (monthly/yearly)',
      },
      includeIncognito: {
        type: GraphQLBoolean,
        description: 'Whether outgoing incognito contributions should be included. Only works when user is an admin.',
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
    type: new GraphQLNonNull(ConversationCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 15 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
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
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 30 },
    },
  },
  expensesTags: {
    type: new GraphQLList(TagStats),
    description: 'Returns expense tags for collective sorted by popularity',
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 30 },
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
      type: {
        type: new GraphQLList(PaymentMethodType),
        description: 'Filter on given types (CREDITCARD, GIFTCARD...)',
      },
      enumType: {
        type: new GraphQLList(PaymentMethodType),
        description: 'Filter on given types (CREDITCARD, GIFTCARD...)',
        deprecationReason: '2021-08-20: use type instead from now',
      },
      service: {
        type: new GraphQLList(PaymentMethodService),
        description: 'Filter on the given service types (opencollective, stripe, paypal...)',
      },
      includeExpired: {
        type: GraphQLBoolean,
        description:
          'Whether to include expired payment methods. Payment methods expired since more than 6 months will never be returned.',
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
      onlyPublishedUpdates: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Only return published updates. You must be an admin of the account to see unpublished updates.',
      },
      onlyChangelogUpdates: { type: GraphQLBoolean },
      orderBy: {
        type: new GraphQLNonNull(ChronologicalOrderInput),
        defaultValue: ChronologicalOrderInput.defaultValue,
      },
      searchTerm: { type: GraphQLString },
    },
    async resolve(collective, { limit, offset, onlyPublishedUpdates, onlyChangelogUpdates, orderBy, searchTerm }, req) {
      let where = {
        CollectiveId: collective.id,
        [Op.and]: [],
      };
      if (onlyPublishedUpdates || !req.remoteUser?.isAdminOfCollective(collective)) {
        where = assign(where, { publishedAt: { [Op.ne]: null } });
      }
      if (onlyChangelogUpdates) {
        where = assign(where, { isChangelog: true });
      }
      const orderByFilter = [orderBy.field, orderBy.direction];

      // Add search filter
      let include;
      if (searchTerm) {
        const searchConditions = [];
        include = [{ association: 'fromCollective', required: true, attributes: [] }];
        const searchedId = searchTerm.match(/^#?(\d+)$/)?.[1];

        // If search term starts with a `#`, only search by ID
        if (searchTerm[0] !== '#' || !searchedId) {
          const sanitizedTerm = searchTerm.replace(/(_|%|\\)/g, '\\$1');
          const ilikeQuery = `%${sanitizedTerm}%`;
          searchConditions.push(
            { '$fromCollective.slug$': { [Op.iLike]: ilikeQuery } },
            { '$fromCollective.name$': { [Op.iLike]: ilikeQuery } },
            { $title$: { [Op.iLike]: ilikeQuery } },
            { $html$: { [Op.iLike]: ilikeQuery } },
          );
        }

        if (searchedId) {
          searchConditions.push({ id: parseInt(searchedId) });
        }

        where[Op.and].push({ [Op.or]: searchConditions });
      }

      const query = {
        where,
        include,
        order: [orderByFilter],
        limit,
        offset,
      };

      const result = await models.Update.findAndCountAll(query);
      return { nodes: result.rows, totalCount: result.count, limit, offset };
    },
  },
  features: {
    type: new GraphQLNonNull(CollectiveFeatures),
    description: 'Describes the features enabled and available for this account',
    resolve(collective) {
      return collective;
    },
  },
  virtualCards: {
    type: new GraphQLNonNull(VirtualCardCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
      state: { type: GraphQLString, defaultValue: null },
      merchantAccount: { type: AccountReferenceInput, defaultValue: null },
      dateFrom: {
        type: GraphQLDateTime,
        defaultValue: null,
        description: 'Only return expenses that were created after this date',
      },
      dateTo: {
        type: GraphQLDateTime,
        defaultValue: null,
        description: 'Only return expenses that were created before this date',
      },
      orderBy: {
        type: ChronologicalOrderInput,
        defaultValue: ChronologicalOrderInput.defaultValue,
      },
    },
    async resolve(account, args, req) {
      if (!req.remoteUser?.isAdminOfCollective(account)) {
        throw new Unauthorized('You need to be logged in as an admin of the collective to see its virtual cards');
      }

      let merchantId;
      if (!isEmpty(args.merchantAccount)) {
        merchantId = (await fetchAccountWithReference(args.merchantAccount, { throwIfMissing: true })).id;
      }

      const query = {
        group: 'VirtualCard.id',
        where: {
          CollectiveId: account.id,
        },
        limit: args.limit,
        offset: args.offset,
        order: [[args.orderBy.field, args.orderBy.direction]],
      };

      if (args.dateFrom) {
        query.where['createdAt'] = { [Op.gte]: args.dateFrom };
      }
      if (args.dateTo) {
        query.where['createdAt'] = Object.assign({}, query.where['createdAt'], { [Op.lte]: args.dateTo });
      }

      if (args.state) {
        query.where.data = { state: args.state };
      }

      if (merchantId) {
        if (!query.where.data) {
          query.where.data = {};
        }
        query.where.data.type = 'MERCHANT_LOCKED';
        query.include = [
          {
            attributes: [],
            association: 'expenses',
            required: true,
            where: {
              CollectiveId: merchantId,
            },
          },
        ];
      }

      const result = await models.VirtualCard.findAndCountAll(query);

      return {
        nodes: result.rows,
        totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
        limit: args.limit,
        offset: args.offset,
      };
    },
  },
  virtualCardMerchants: {
    type: new GraphQLNonNull(AccountCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
    },
    async resolve(account, args, req) {
      if (!req.remoteUser?.isAdminOfCollective(account)) {
        throw new Unauthorized(
          'You need to be logged in as an admin of the collective to see its virtual card merchants',
        );
      }

      const result = await models.Collective.findAndCountAll({
        group: 'Collective.id',
        where: {
          type: CollectiveTypes.VENDOR,
        },
        include: [
          {
            attributes: [],
            association: 'submittedExpenses',
            required: true,
            include: [
              {
                attributes: [],
                association: 'virtualCard',
                required: true,
                where: {
                  CollectiveId: account.id,
                  data: { type: 'MERCHANT_LOCKED' },
                },
              },
            ],
          },
        ],
      });

      return {
        nodes: result.rows,
        totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
        limit: args.limit,
        offset: args.offset,
      };
    },
  },
  childrenAccounts: {
    type: new GraphQLNonNull(AccountCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
      accountType: {
        type: new GraphQLList(AccountType),
      },
    },
    async resolve(account, args) {
      if (args.limit > 100) {
        throw new BadRequest('Cannot fetch more than 100 accounts at the same time, please adjust the limit');
      }

      const where = {
        ParentCollectiveId: account.id,
      };
      if (args.accountType && args.accountType.length > 0) {
        where.type = {
          [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
        };
      }

      const result = await models.Collective.findAndCountAll({
        where,
        limit: args.limit,
        offset: args.offset,
      });

      return {
        nodes: result.rows,
        totalCount: result.count,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },
  policies: {
    type: new GraphQLList(Policy),
    async resolve(account, _, req) {
      if (req.remoteUser?.isAdminOfCollective(account)) {
        return account.data?.policies || [];
      }
      return null;
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
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
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
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
    filter: { type: AccountOrdersFilter },
    status: { type: new GraphQLList(OrderStatus) },
    tierSlug: { type: GraphQLString },
    onlySubscriptions: {
      type: GraphQLBoolean,
      description: 'Only returns orders that have an subscription (monthly/yearly)',
    },
    includeIncognito: {
      type: GraphQLBoolean,
      description: 'Whether outgoing incognito contributions should be included. Only works when user is an admin.',
    },
    orderBy: {
      type: ChronologicalOrderInput,
      defaultValue: ChronologicalOrderInput.defaultValue,
    },
  },
  async resolve(collective, args, req) {
    const outgoingFromCollectiveIds = [collective.id];
    let where, include;

    // Filter for incognito contributions
    const includesOutgoing = args.filter !== 'INCOMING';
    const isUser = collective.type === 'USER';
    if (args.includeIncognito && includesOutgoing && isUser && req.remoteUser?.CollectiveId === collective.id) {
      const incognitoProfile = await req.remoteUser.getIncognitoProfile();
      if (incognitoProfile) {
        outgoingFromCollectiveIds.push(incognitoProfile.id);
      }
    }

    // Filter direction (INCOMING/OUTGOING)
    if (args.filter === 'OUTGOING') {
      where = { FromCollectiveId: outgoingFromCollectiveIds };
    } else if (args.filter === 'INCOMING') {
      where = { CollectiveId: collective.id };
    } else {
      where = { [Op.or]: { CollectiveId: collective.id, FromCollectiveId: outgoingFromCollectiveIds } };
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
    type: new GraphQLNonNull(ConversationCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 15 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
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
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 30 },
    },
    async resolve(collective, _, { limit }) {
      return models.Conversation.getMostPopularTagsForCollective(collective.id, limit);
    },
  },
  expensesTags: {
    type: new GraphQLList(TagStats),
    description: 'Returns expense tags for collective sorted by popularity',
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 30 },
    },
    async resolve(collective, _, { limit }) {
      return models.Expense.getMostPopularExpenseTagsForCollective(collective.id, limit);
    },
  },
  payoutMethods: {
    type: new GraphQLList(PayoutMethod),
    description: 'The list of payout methods that this collective can use to get paid',
    async resolve(collective, _, req) {
      if (req.remoteUser && req.remoteUser.isAdminOfCollective(collective)) {
        return req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
      }
      // Exception for Fiscal Hosts so people can post Expense accross hosts
      if (collective.isHostAccount) {
        const payoutMethods = await req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
        for (const payoutMethod of payoutMethods) {
          allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id);
        }
        return payoutMethods.filter(
          pm => pm.isSaved && [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(pm.type),
        );
      }
      return null;
    },
  },
  paymentMethods: {
    type: new GraphQLNonNull(new GraphQLList(PaymentMethod)),
    args: {
      type: {
        type: new GraphQLList(PaymentMethodType),
      },
      enumType: {
        type: new GraphQLList(PaymentMethodType),
        deprecationReason: '2021-08-20: use type instead from now',
      },
      service: { type: new GraphQLList(PaymentMethodService) },
      includeExpired: {
        type: GraphQLBoolean,
        description:
          'Whether to include expired payment methods. Payment methods expired since more than 6 months will never be returned.',
      },
    },
    description: 'The list of payment methods that this collective can use to pay for Orders',
    async resolve(collective, args, req) {
      if (!req.remoteUser?.isAdminOfCollective(collective)) {
        return [];
      }

      const now = new Date();
      const paymentMethods = await req.loaders.PaymentMethod.findByCollectiveId.load(collective.id);

      return paymentMethods.filter(pm => {
        if (args.enumType && !args.enumType.map(t => t.toLowerCase()).includes(pm.type)) {
          return false;
        } else if (args.type && !args.type.map(t => t.toLowerCase()).includes(pm.type)) {
          return false;
        } else if (args.service && !args.service.map(s => s.toLowerCase()).includes(pm.service)) {
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
