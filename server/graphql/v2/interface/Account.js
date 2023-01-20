import { GraphQLBoolean, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-type-json';
import { assign, get, invert, isEmpty, isNull, merge, omitBy } from 'lodash';

import { types as CollectiveTypes } from '../../../constants/collectives';
import FEATURE from '../../../constants/feature';
import { buildSearchConditions } from '../../../lib/search';
import { canSeeLegalName } from '../../../lib/user-permissions';
import models, { Op } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { allowContextPermission, getContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkRemoteUserCanUseAccount, checkScope } from '../../common/scope-check';
import { BadRequest } from '../../errors';
import { CollectiveFeatures } from '../../v1/CollectiveInterface.js';
import { AccountCollection } from '../collection/AccountCollection';
import { ConversationCollection } from '../collection/ConversationCollection';
import { MemberCollection, MemberOfCollection } from '../collection/MemberCollection';
import { OAuthApplicationCollection } from '../collection/OAuthApplicationCollection';
import { OrderCollection } from '../collection/OrderCollection';
import { TransactionCollection } from '../collection/TransactionCollection';
import { UpdateCollection } from '../collection/UpdateCollection';
import { VirtualCardCollection } from '../collection/VirtualCardCollection';
import { WebhookCollection, WebhookCollectionArgs, WebhookCollectionResolver } from '../collection/WebhookCollection';
import { AccountType, AccountTypeToModelMapping, ImageFormat, MemberRole } from '../enum';
import { ActivityChannel } from '../enum/ActivityChannel';
import { ExpenseType } from '../enum/ExpenseType';
import { PaymentMethodService } from '../enum/PaymentMethodService';
import { PaymentMethodType } from '../enum/PaymentMethodType';
import { idEncode } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { ORDER_BY_PSEUDO_FIELDS, OrderByInput } from '../input/OrderByInput';
import {
  UPDATE_CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  UpdateChronologicalOrderInput,
} from '../input/UpdateChronologicalOrderInput';
import AccountPermissions from '../object/AccountPermissions';
import { AccountStats } from '../object/AccountStats';
import { ActivitySubscription } from '../object/ActivitySubscription';
import { ConnectedAccount } from '../object/ConnectedAccount';
import { Location } from '../object/Location';
import { MemberInvitation } from '../object/MemberInvitation';
import { PaymentMethod } from '../object/PaymentMethod';
import PayoutMethod from '../object/PayoutMethod';
import { Policies } from '../object/Policies';
import { SocialLink } from '../object/SocialLink';
import { TagStats } from '../object/TagStats';
import { TransferWise } from '../object/TransferWise';
import { OrdersCollectionArgs, OrdersCollectionResolver } from '../query/collection/OrdersCollectionQuery';
import {
  TransactionsCollectionArgs,
  TransactionsCollectionResolver,
} from '../query/collection/TransactionsCollectionQuery';
import EmailAddress from '../scalar/EmailAddress';

import { CollectionArgs } from './Collection';
import { HasMembersFields } from './HasMembers';
import { IsMemberOfFields } from './IsMemberOf';

const accountFieldsDefinition = () => ({
  id: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'The public id identifying the account (ie: 5v08jk63-w4g9nbpz-j7qmyder-p7ozax5g)',
  },
  legacyId: {
    type: new GraphQLNonNull(GraphQLInt),
    description: 'The internal database identifier of the collective (ie: 580)',
    deprecationReason: '2020-01-01: should only be used during the transition to GraphQL API v2.',
  },
  slug: {
    type: new GraphQLNonNull(GraphQLString),
    description: 'The slug identifying the account (ie: babel)',
  },
  type: {
    type: new GraphQLNonNull(AccountType),
    description: 'The type of the account (BOT/COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL/VENDOR)',
  },
  name: {
    type: GraphQLString,
    description: 'Public name',
  },
  legalName: {
    type: GraphQLString,
    description: 'Private, legal name. Used for expense receipts, taxes, etc. Scope: "account".',
    resolve: async (account, _, req) => {
      if (!checkScope(req, 'account')) {
        return null;
      }
      if (
        !canSeeLegalName(req.remoteUser, account) &&
        !getContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_LEGAL_NAME, account.id)
      ) {
        return null;
      } else if (account.isIncognito) {
        if (!checkScope(req, 'incognito')) {
          return null;
        }
        const mainProfile = await req.loaders.Collective.mainProfileFromIncognito.load(account.id);
        if (mainProfile) {
          return mainProfile.legalName || mainProfile.name;
        }
      } else {
        return account.legalName;
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
    deprecationReason: '2022-06-03: Please use repositoryUrl',
  },
  repositoryUrl: {
    type: GraphQLString,
  },
  socialLinks: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SocialLink))),
    async resolve(collective, _, req) {
      return req.loaders.SocialLink.byCollectiveId.load(collective.id);
    },
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
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns whether this account is archived',
  },
  isFrozen: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Whether this account is frozen',
  },
  isActive: {
    type: GraphQLBoolean,
    description: 'Returns whether the account accepts financial contributions.',
  },
  isHost: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns whether the account is setup to Host collectives.',
  },
  isAdmin: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns true if the remote user is an admin of this account',
  },
  parentAccount: {
    type: Account,
    deprecationReason: '2022-12-16: use parent on AccountWithParent instead',
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
  memberInvitations: {
    description: 'Get pending member invitations for this account',
    type: new GraphQLList(MemberInvitation),
    args: {
      role: { type: new GraphQLList(MemberRole) },
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
  emails: {
    type: new GraphQLList(new GraphQLNonNull(EmailAddress)),
    description:
      'Returns the emails of the account. Individuals only have one, but organizations can have multiple emails.',
  },
  transactions: {
    type: new GraphQLNonNull(TransactionCollection),
    args: {
      ...TransactionsCollectionArgs,
    },
  },
  orders: {
    type: new GraphQLNonNull(OrderCollection),
    args: {
      ...OrdersCollectionArgs,
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
  supportedExpenseTypes: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ExpenseType))),
    description: 'The list of expense types supported by this account',
    async resolve(collective, _, req) {
      const host = collective.HostCollectiveId && (await req.loaders.Collective.byId.load(collective.HostCollectiveId));
      const parent =
        collective.ParentCollectiveId && (await req.loaders.Collective.byId.load(collective.ParentCollectiveId));

      // Aggregate all configs, using the order of priority collective > parent > host
      const getExpenseTypes = account => omitBy(account?.settings?.expenseTypes, isNull);
      const defaultExpenseTypes = { GRANT: false, INVOICE: true, RECEIPT: true };
      const aggregatedConfig = merge(defaultExpenseTypes, ...[host, parent, collective].map(getExpenseTypes));
      return Object.keys(aggregatedConfig).filter(key => aggregatedConfig[key]); // Return only the truthy ones
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
  paymentMethodsWithPendingConfirmation: {
    type: new GraphQLList(PaymentMethod),
    description:
      'The list of payment methods for this account that are pending a client confirmation (3D Secure / SCA)',
  },
  connectedAccounts: {
    type: new GraphQLList(ConnectedAccount),
    description: 'The list of connected accounts (Stripe, Twitter, etc ...)',
  },
  oAuthApplications: {
    type: OAuthApplicationCollection,
    description: 'The list of applications created by this account. Admin only. Scope: "applications".',
    args: {
      ...CollectionArgs,
    },
    async resolve(collective, args, req) {
      if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'applications')) {
        return null;
      }

      const { limit, offset } = args;
      const order = [['createdAt', 'DESC']];
      const where = { CollectiveId: collective.id, type: 'oAuth' };
      const result = await models.Application.findAndCountAll({ where, order, limit, offset });
      return { nodes: result.rows, totalCount: result.count, limit, offset };
    },
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
    description:
      'Updates published by the account. To see unpublished updates, you need to be an admin and have the scope "updates".',
    args: {
      ...CollectionArgs,
      onlyPublishedUpdates: {
        type: GraphQLBoolean,
        defaultValue: false,
        description: 'Only return published updates.',
      },
      onlyChangelogUpdates: { type: GraphQLBoolean },
      orderBy: {
        type: new GraphQLNonNull(UpdateChronologicalOrderInput),
        defaultValue: UPDATE_CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
      },
      searchTerm: { type: GraphQLString },
    },
    async resolve(collective, { limit, offset, onlyPublishedUpdates, onlyChangelogUpdates, orderBy, searchTerm }, req) {
      let where = {
        CollectiveId: collective.id,
        [Op.and]: [],
      };
      if (onlyPublishedUpdates || !req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'updates')) {
        where = assign(where, { publishedAt: { [Op.ne]: null } });
      }
      if (onlyChangelogUpdates) {
        where = assign(where, { isChangelog: true });
      }

      // Order by
      const order = [[orderBy.field, orderBy.direction]];
      if (order[0][0] === 'publishedAt') {
        order.push(['createdAt', 'DESC']); // publishedAt is nullable so we need to fallback on createdAt
      }

      // Add search filter
      const include = [];
      const searchTermConditions = buildSearchConditions(searchTerm, {
        idFields: ['id'],
        slugFields: ['$fromCollective.slug$'],
        textFields: ['$fromCollective.name$', 'title', 'html'],
      });

      if (searchTermConditions.length) {
        include.push({ association: 'fromCollective', required: true, attributes: [] });
        where[Op.and].push({ [Op.or]: searchTermConditions });
      }

      const query = { where, include, order, limit, offset };
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
    type: VirtualCardCollection,
    description: 'Virtual Cards attached to the account. Admin only. Scope: "virtualCards".',
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
      if (!req.remoteUser?.isAdminOfCollective(account) || !checkScope(req, 'virtualCards')) {
        return null;
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
    type: AccountCollection,
    description: 'Virtual Cards Merchants used by the account. Admin only. Scope: "virtualCards".',
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
    },
    async resolve(account, args, req) {
      if (!req.remoteUser?.isAdminOfCollective(account) || !checkScope(req, 'virtualCards')) {
        return null;
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
    type: new GraphQLNonNull(Policies),
    description:
      'Policies for the account. To see non-public policies you need to be admin and have the scope: "account".',
    async resolve(account) {
      return account;
    },
  },
  activitySubscriptions: {
    type: new GraphQLList(ActivitySubscription),
    description: 'List of activities that the logged-in user is subscribed for this collective',
    args: {
      channel: {
        type: ActivityChannel,
      },
    },
    async resolve(collective, args, req) {
      if (!req.remoteUser) {
        return null;
      }
      checkRemoteUserCanUseAccount(req);

      const where = { UserId: req.remoteUser.id, CollectiveId: collective.id };
      if (args.channel) {
        where['channel'] = args.channel;
      }

      return models.Notification.findAll({ where });
    },
  },
  permissions: {
    type: new GraphQLNonNull(AccountPermissions),
    description: 'Logged-in user permissions on an account',
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
    ...TransactionsCollectionArgs,
  },
  async resolve(collective, args, req) {
    return TransactionsCollectionResolver({ account: { legacyId: collective.id }, ...args }, req);
  },
};

const accountOrders = {
  type: new GraphQLNonNull(OrderCollection),
  args: {
    ...OrdersCollectionArgs,
  },
  async resolve(collective, args, req) {
    return OrdersCollectionResolver({ account: { legacyId: collective.id }, ...args }, req);
  },
};

const accountWebhooks = {
  type: new GraphQLNonNull(WebhookCollection),
  args: {
    ...WebhookCollectionArgs,
  },
  async resolve(collective, args, req) {
    return WebhookCollectionResolver({ account: { legacyId: collective.id }, ...args }, req);
  },
};

export const AccountFields = {
  ...accountFieldsDefinition(),
  id: {
    type: new GraphQLNonNull(GraphQLString),
    resolve(collective) {
      return idEncode(collective.id, 'account');
    },
  },
  legacyId: {
    type: new GraphQLNonNull(GraphQLInt),
    resolve(collective) {
      return collective.id;
    },
  },
  type: {
    type: new GraphQLNonNull(AccountType),
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
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns whether this account is archived',
    resolve(collective) {
      return Boolean(collective.deactivatedAt);
    },
  },
  isFrozen: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Whether this account is frozen',
    resolve(collective) {
      return get(collective, `data.features.${FEATURE.ALL}`) === false;
    },
  },
  isHost: {
    type: new GraphQLNonNull(GraphQLBoolean),
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
  emails: {
    type: new GraphQLList(new GraphQLNonNull(EmailAddress)),
    description:
      'Returns the emails of the account. Individuals only have one, but organizations can have multiple emails.',
    async resolve(collective, _, req) {
      if (await req.loaders.Collective.canSeePrivateInfo.load(collective.id)) {
        return req.loaders.Member.adminUserEmailsForCollective.load(collective);
      }
    },
  },
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
    description:
      'The list of payout methods that this collective can use to get paid. In most cases, admin only and scope: "expenses".',
    async resolve(collective, _, req) {
      // Scope check is a a bit more complex because we have to accomodate the case where payoutMethods are public
      if (
        req.remoteUser?.isAdminOfCollective(collective) &&
        !collective.isHostAccount &&
        !checkScope(req, 'expenses')
      ) {
        return null;
      }

      if (req.remoteUser?.isAdminOfCollective(collective)) {
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
    type: new GraphQLList(PaymentMethod),
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
    description:
      'The list of payment methods that this collective can use to pay for Orders. Admin only. Scope: "orders".',
    async resolve(collective, args, req) {
      if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'orders')) {
        return null;
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
  paymentMethodsWithPendingConfirmation: {
    type: new GraphQLList(PaymentMethod),
    description:
      'The list of payment methods for this account that are pending a client confirmation (3D Secure / SCA)',
    async resolve(collective, _, req) {
      if (!req.remoteUser?.isAdminOfCollective(collective)) {
        return null;
      }

      return models.PaymentMethod.findAll({
        where: { CollectiveId: collective.id },
        group: ['PaymentMethod.id'],
        include: [
          {
            model: models.Order,
            required: true,
            attributes: [],
            include: [{ model: models.Subscription, required: true, attributes: [], where: { isActive: true } }],
            where: {
              data: { needsConfirmation: true },
              status: {
                [Op.in]: ['REQUIRE_CLIENT_CONFIRMATION', 'ERROR', 'PENDING'],
              },
            },
          },
        ],
      });
    },
  },
  connectedAccounts: {
    type: new GraphQLList(ConnectedAccount),
    description: 'The list of connected accounts (Stripe, Twitter, etc ...). Admin only. Scope: "connectedAccounts".',
    // Only for admins, no pagination
    async resolve(collective, _, req) {
      if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'connectedAccounts')) {
        return null;
      }

      return req.loaders.Collective.connectedAccounts.load(collective.id);
    },
  },
  categories: {
    type: new GraphQLNonNull(new GraphQLList(GraphQLString)),
    resolve(collective) {
      return get(collective.data, 'categories', []);
    },
  },
  webhooks: accountWebhooks,
  permissions: {
    type: new GraphQLNonNull(AccountPermissions),
    description: 'Logged-in user permissions on an account',
    resolve: collective => collective, // Individual resolvers in `AccountPermissions`
  },
};

export default Account;
