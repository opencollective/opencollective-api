import Promise from 'bluebird';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { get, uniq } from 'lodash';
import { isEmail } from 'validator';

import { roles } from '../../constants';
import { types as CollectiveTypes } from '../../constants/collectives';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { fetchCollectiveId } from '../../lib/cache';
import { getConsolidatedInvoicesData } from '../../lib/pdf';
import rawQueries from '../../lib/queries';
import { searchCollectivesByEmail, searchCollectivesInDB } from '../../lib/search';
import { toIsoDateStr } from '../../lib/utils';
import models, { Op, sequelize } from '../../models';
import { allowContextPermission, PERMISSION_TYPE } from '../common/context-permissions';
import { canDownloadInvoice } from '../common/transactions';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../errors';

import { ApplicationType } from './Application';
import {
  CollectiveInterfaceType,
  CollectiveOrderFieldType,
  CollectiveSearchResultsType,
  HostCollectiveOrderFieldType,
  TypeOfCollectiveType,
} from './CollectiveInterface';
import { TransactionInterfaceType } from './TransactionInterface';
import {
  InvoiceType,
  MemberInvitationType,
  MemberType,
  OrderDirectionType,
  OrderType,
  PaymentMethodType,
  TierType,
  UpdateType,
  UserType,
} from './types';

const queries = {
  Collective: {
    type: CollectiveInterfaceType,
    args: {
      slug: { type: GraphQLString },
      id: { type: GraphQLInt },
      throwIfMissing: {
        type: GraphQLBoolean,
        defaultValue: true,
        description: 'If false, will return null instead of an error if collective is not found',
      },
    },
    resolve(_, args) {
      let collective;
      if (args.slug) {
        collective = models.Collective.findBySlug(args.slug.toLowerCase(), null, args.throwIfMissing);
      } else if (args.id) {
        collective = models.Collective.findByPk(args.id);
      } else {
        return new Error('Please provide a slug or an id');
      }
      if (!collective && args.throwIfMissing) {
        throw new NotFound('Collective not found');
      }
      return collective;
    },
  },

  Tier: {
    type: TierType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args) {
      return models.Tier.findByPk(args.id);
    },
  },

  LoggedInUser: {
    type: UserType,
    resolve(_, args, req) {
      return req.remoteUser;
    },
  },

  AuthenticatedUser: {
    type: CollectiveInterfaceType,
    deprecationReason: '2021-01-29: Not used anymore',
    resolve(_, args, req) {
      return models.Collective.findByPk(req.remoteUser.CollectiveId);
    },
  },

  allInvoices: {
    type: new GraphQLList(InvoiceType),
    args: {
      fromCollectiveSlug: { type: new GraphQLNonNull(GraphQLString) },
    },
    async resolve(_, args, req) {
      const fromCollective = await models.Collective.findOne({
        where: { slug: args.fromCollectiveSlug },
      });
      if (!fromCollective) {
        throw new NotFound('User or organization not found');
      }
      if (
        !req.remoteUser ||
        (!req.remoteUser.isAdminOfCollective(fromCollective) &&
          !req.remoteUser.hasRole(roles.ACCOUNTANT, fromCollective.id))
      ) {
        throw new Unauthorized("You don't have permission to access invoices for this user");
      }

      const invoices = await getConsolidatedInvoicesData(fromCollective);

      return invoices;
    },
  },

  /**
   * Get an invoice for a single transaction.
   * As we consider `uuid` to be private, we intentionally don't protect the
   * call so the URL can be sent easily.
   */
  TransactionInvoice: {
    type: InvoiceType,
    args: {
      transactionUuid: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Slug of the transaction.',
      },
    },
    async resolve(_, args, req) {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to generate a receipt');
      }

      // Fetch transaction
      let transaction = await models.Transaction.findOne({ where: { uuid: args.transactionUuid } });
      if (!transaction) {
        throw new NotFound(`Transaction ${args.transactionUuid} doesn't exists`);
      }

      // If using a gift card, then billed collective will be the emitter
      const fromCollectiveId = transaction.paymentMethodProviderCollectiveId();

      // Always take the CREDIT transaction if available
      if (transaction.type === 'DEBIT') {
        const oppositeTransaction = await transaction.getOppositeTransaction();
        if (oppositeTransaction) {
          transaction = oppositeTransaction;
        }
      }

      // Load transaction host
      let host;
      if (transaction.HostCollectiveId) {
        // If a `HostCollectiveId` is defined, we load it directly
        host = await transaction.getHostCollective();
      } else {
        // TODO: Keeping the code below to be safe and not break anything, but the logic is wrong:
        // A collective can change host and we would display the wrong one there. `Transaction.HostCollectiveId`
        // should be the single source of truth for this.
        const collectiveId = transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId;
        const collective = await models.Collective.findByPk(collectiveId);
        host = await collective.getHostCollective();
      }

      if (!host) {
        throw new Error(`Could not find the fiscal host for this transaction (${transaction.uuid})`);
      }

      // Check permissions
      if (req.remoteUser.isAdminOfCollective(host) || (await canDownloadInvoice(transaction, null, req))) {
        allowContextPermission(req, PERMISSION_TYPE.SEE_ACCOUNT_LEGAL_NAME, fromCollectiveId);
      } else {
        throw new Forbidden('You are not allowed to download this receipt');
      }

      // Generate date string for receipt slug
      const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());

      // Generate invoice
      const invoice = {
        title: get(host, 'settings.invoiceTitle'),
        extraInfo: get(host, 'settings.invoice.extraInfo'),
        HostCollectiveId: host.id,
        FromCollectiveId: fromCollectiveId,
        slug: `${host.name}_${createdAtString}_${args.transactionUuid}`,
        currency: transaction.hostCurrency,
        totalAmount: Math.abs(transaction.amountInHostCurrency),
        transactions: [transaction],
        year: transaction.createdAt.getFullYear(),
        month: transaction.createdAt.getMonth() + 1,
        day: transaction.createdAt.getDate(),
      };

      return invoice;
    },
  },

  /*
   * Given a collective slug or id, returns all its transactions
   */
  allTransactions: {
    type: new GraphQLList(TransactionInterfaceType),
    description: `
    Given a collective, returns all its transactions:
    - Debit transactions made by collective without using a gift card
    - Debit transactions made using a gift card from collective
    - Credit transactions made to collective
    `,
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      type: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      dateFrom: { type: GraphQLString },
      dateTo: { type: GraphQLString },
      kinds: { type: new GraphQLList(GraphQLString) },
      includeExpenseTransactions: {
        type: GraphQLBoolean,
        default: true,
        description: 'If false, only the transactions not linked to an expense (orders/refunds) will be returned',
      },
      fetchDataFromLedger: { type: GraphQLBoolean }, // flag to go with either api or ledger transactions
      includeHostedCollectivesTransactions: {
        type: GraphQLBoolean,
      } /** flag to determine
        whether we should include the transactions of the collectives of that host(if it's a host collective) */,
    },
    async resolve(_, args) {
      // Load collective
      const { CollectiveId, collectiveSlug } = args;
      if (!CollectiveId && !collectiveSlug) {
        throw new Error('You must specify a collective ID or a Slug');
      }
      const where = CollectiveId ? { id: CollectiveId } : { slug: collectiveSlug };
      const collective = await models.Collective.findOne({ where });
      if (!collective) {
        throw new Error('This collective does not exist');
      }

      return collective.getTransactions({
        order: [['createdAt', 'DESC'], ['kind'], ['type']],
        type: args.type,
        limit: args.limit,
        offset: args.offset,
        startDate: args.dateFrom,
        endDate: args.dateTo,
        includeExpenseTransactions: args.includeExpenseTransactions,
        kinds: args.kinds,
      });
    },
  },

  Application: {
    type: ApplicationType,
    args: {
      id: { type: GraphQLInt },
    },
    async resolve(_, args) {
      if (args.id) {
        return models.Application.findByPk(args.id);
      } else {
        return new Error('Please provide an id.');
      }
    },
  },

  /*
   * Given a collective slug, returns all updates
   */
  allUpdates: {
    type: new GraphQLList(UpdateType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      includeHostedCollectives: { type: GraphQLBoolean },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args, req) {
      const query = { where: {} };
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }
      query.order = [
        ['publishedAt', 'DESC'],
        ['createdAt', 'DESC'],
      ];
      if (!req.remoteUser || !req.remoteUser.isAdmin(args.CollectiveId)) {
        query.where.publishedAt = { [Op.ne]: null };
      }
      const collective = await req.loaders.Collective.byId.load(args.CollectiveId);
      if (!collective) {
        throw new Error('Collective not found');
      }
      let collectiveIds;
      if (args.includeHostedCollectives) {
        const members = await models.Member.findAll({
          where: {
            MemberCollectiveId: collective.id,
            role: 'HOST',
          },
        });
        collectiveIds = members.map(member => member.CollectiveId);
      } else {
        collectiveIds = [args.CollectiveId];
      }
      query.where.CollectiveId = { [Op.in]: collectiveIds };
      return models.Update.findAll(query);
    },
  },

  /*
   * Given a collective slug, returns all orders
   */
  allOrders: {
    type: new GraphQLList(OrderType),
    deprecationReason: '2021-01-29: Not used anymore',
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      includeHostedCollectives: { type: GraphQLBoolean },
      status: {
        type: GraphQLString,
        description: 'Filter by status (PAID, PENDING, ERROR, ACTIVE, CANCELLED)',
      },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args) {
      const query = { where: {} };
      const CollectiveId = args.CollectiveId || (await fetchCollectiveId(args.collectiveSlug));
      if (args.status) {
        query.where.status = args.status;
      }
      if (args.category) {
        query.where.category = { [Op.iLike]: args.category };
      }
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }
      query.order = [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ];

      let collectiveIds;
      // if is host, we get all the orders across all the hosted collectives
      if (args.includeHostedCollectives) {
        const members = await models.Member.findAll({
          attributes: ['CollectiveId'],
          where: {
            MemberCollectiveId: CollectiveId,
            role: 'HOST',
          },
        });
        const membersCollectiveIds = members.map(member => member.CollectiveId);
        collectiveIds = [CollectiveId, ...membersCollectiveIds];
      } else {
        collectiveIds = [CollectiveId];
      }

      query.where.CollectiveId = { [Op.in]: collectiveIds };

      return models.Order.findAll(query);
    },
  },

  /*
   * Given a Transaction id, returns a transaction details
   */
  Transaction: {
    type: TransactionInterfaceType,
    args: {
      id: {
        type: GraphQLInt,
      },
      uuid: {
        type: GraphQLString,
      },
    },
    resolve(_, args) {
      return models.Transaction.findOne({ where: { ...args } });
    },
  },

  /*
   * Returns all collectives
   */
  allCollectives: {
    type: CollectiveSearchResultsType,
    args: {
      slugs: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch collectives with a list of collective slug',
      },
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch all collectives that match at least one of the tags',
      },
      type: {
        type: TypeOfCollectiveType,
        description: 'COLLECTIVE, USER, ORGANIZATION, EVENT',
      },
      HostCollectiveId: {
        type: GraphQLInt,
        description: 'Fetch all collectives hosted by HostCollectiveId',
      },
      hostCollectiveSlug: {
        type: GraphQLString,
        description: 'Fetch all collectives hosted by hostCollectiveSlug',
      },
      isActive: {
        description: 'Only return active collectives',
        type: GraphQLBoolean,
      },
      isPledged: {
        description: 'Only return pledged or non-pledged collectives',
        type: GraphQLBoolean,
      },
      memberOfCollectiveSlug: {
        type: GraphQLString,
        description: 'Fetch all collectives that `memberOfCollectiveSlug` is a member of',
      },
      minBackerCount: {
        description: 'Filter collectives with this minimum number of backers',
        type: GraphQLInt,
      },
      role: {
        type: GraphQLString,
        description: 'Only fetch the collectives where `memberOfCollectiveSlug` has the specified role',
      },
      ParentCollectiveId: {
        type: GraphQLInt,
        description: 'Fetch all collectives that are a child of `ParentCollectiveId`. Used for "SuperCollectives"',
      },
      orderBy: {
        defaultValue: 'name',
        type: CollectiveOrderFieldType,
      },
      orderDirection: {
        defaultValue: 'ASC',
        type: OrderDirectionType,
      },
      limit: {
        defaultValue: 10,
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
    },
    async resolve(_, args) {
      const query = {
        where: { data: { hideFromSearch: { [Op.not]: true } } },
        limit: args.limit,
        include: [],
      };

      if (args.slugs) {
        query.where.slug = { [Op.in]: args.slugs };
      }

      if (args.hostCollectiveSlug) {
        args.HostCollectiveId = await fetchCollectiveId(args.hostCollectiveSlug);
      }

      if (args.memberOfCollectiveSlug) {
        args.memberOfCollectiveId = await fetchCollectiveId(args.memberOfCollectiveSlug);
      }

      if (args.memberOfCollectiveId) {
        const memberCond = {
          model: models.Member,
          required: true,
          where: {
            MemberCollectiveId: args.memberOfCollectiveId,
          },
        };
        if (args.role) {
          memberCond.where.role = args.role.toUpperCase();
        }
        query.include.push(memberCond);
      }

      if (args.HostCollectiveId) {
        query.where.HostCollectiveId = args.HostCollectiveId;
      }
      if (args.ParentCollectiveId) {
        query.where.ParentCollectiveId = args.ParentCollectiveId;
      }
      if (args.type) {
        query.where.type = args.type;
      }
      if (args.tags) {
        query.where.tags = { [Op.overlap]: args.tags };
      }
      if (typeof args.isActive === 'boolean') {
        query.where.isActive = args.isActive;
      }
      if (typeof args.isPledged === 'boolean') {
        query.where.isPledged = args.isPledged;
      }

      if (args.orderBy === 'balance' && (args.ParentCollectiveId || args.HostCollectiveId || args.tags)) {
        const { total, collectives } = await rawQueries.getCollectivesWithBalance(query.where, args);
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.orderBy === 'monthlySpending') {
        const { total, collectives } = await rawQueries.getCollectivesOrderedByMonthlySpending({
          ...args,
          where: query.where,
        });
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.orderBy === 'totalDonations') {
        if (args.isPledged) {
          query.attributes = {
            include: [
              [
                sequelize.literal(`(
                  SELECT  COALESCE(SUM("totalAmount"), 0)
                  FROM    "Orders" o, "Collectives" c
                  WHERE   c."isPledged" IS TRUE
                  AND     o."CollectiveId" = "Collective".id
                )`),
                'totalDonations',
              ],
            ],
          };
          query.order = [[sequelize.col('totalDonations'), args.orderDirection]];
        } else {
          query.attributes = {
            include: [
              [
                sequelize.literal(`(
                  SELECT  COALESCE(SUM("netAmountInCollectiveCurrency"), 0)
                  FROM    "Transactions" t
                  WHERE   t."type" = 'CREDIT'
                  AND     t."CollectiveId" = "Collective".id
                  AND     t."deletedAt" IS NULL
                )`),
                'totalDonations',
              ],
            ],
          };
          query.order = [[sequelize.col('totalDonations'), args.orderDirection]];
        }
      } else if (args.orderBy === 'financialContributors') {
        query.attributes = {
          include: [
            [
              sequelize.literal(`(
                SELECT  COUNT(DISTINCT m."MemberCollectiveId")
                FROM    "Members" m
                WHERE   m."deletedAt" IS NULL
                AND     m."CollectiveId" = "Collective".id
                AND     m."role" = 'BACKER'
              )`),
              'contributors_count',
            ],
          ],
        };

        query.order = [[sequelize.col('contributors_count'), args.orderDirection]];
      } else {
        query.order = [[args.orderBy, args.orderDirection]];
      }

      // Make sure entries are always ordered
      query.order = query.order || [];
      query.order.push(['id', 'ASC']);

      if (args.minBackerCount) {
        const { total, collectives } = await rawQueries.getCollectivesWithMinBackers({
          ...args,
          where: query.where,
        });
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.offset) {
        query.offset = args.offset;
      }

      // this will elminate the odd test accounts and older data we need to cleanup
      query.where = {
        ...query.where,
        createdAt: {
          [Op.not]: null,
        },
        name: {
          [Op.ne]: '',
        },
      };
      const result = await models.Collective.findAndCountAll(query);

      return {
        total: result.count,
        collectives: result.rows,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },

  /*
   * Returns all hosts
   */
  allHosts: {
    type: CollectiveSearchResultsType,
    description: 'Returns all public hosts that are open for applications',
    args: {
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch all collectives that match at least one of the tags',
      },
      currency: {
        type: GraphQLString,
        description: 'Filter hosts by currency',
      },
      orderBy: {
        defaultValue: 'collectives',
        type: HostCollectiveOrderFieldType,
      },
      orderDirection: {
        defaultValue: 'DESC',
        type: OrderDirectionType,
      },
      limit: {
        defaultValue: 10,
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
      onlyOpenHosts: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
      minNbCollectivesHosted: {
        type: new GraphQLNonNull(GraphQLInt),
        defaultValue: 0,
      },
    },
    async resolve(_, args) {
      const { collectives, total } = await rawQueries.getHosts(args);
      return {
        total,
        collectives,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },

  /**
   * Helper to get all tags used in collectives
   */
  allCollectiveTags: {
    type: new GraphQLList(GraphQLString),
    resolve: rawQueries.getUniqueCollectiveTags,
  },

  /*
   * Given a collective slug, returns all members/memberships
   */
  allMembers: {
    type: new GraphQLList(MemberType),
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      includeHostedCollectives: {
        type: GraphQLBoolean,
        description:
          'Include the members of the hosted collectives. Useful to get the list of all users/organizations from a host.',
      },
      memberCollectiveSlug: { type: GraphQLString },
      TierId: { type: GraphQLInt },
      role: { type: GraphQLString },
      type: { type: GraphQLString },
      isActive: { type: GraphQLBoolean },
      orderBy: { type: GraphQLString },
      orderDirection: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args, req) {
      if (!args.CollectiveId && !args.collectiveSlug && !args.memberCollectiveSlug) {
        throw new Error('Please provide a CollectiveId, a collectiveSlug or a memberCollectiveSlug');
      }

      if (args.collectiveSlug) {
        args.CollectiveId = await fetchCollectiveId(args.collectiveSlug);
        if (!args.CollectiveId) {
          throw new Error(`No collective found with collectiveSlug ${args.collectiveSlug}`);
        }
      }

      if (args.memberCollectiveSlug) {
        args.MemberCollectiveId = await fetchCollectiveId(args.memberCollectiveSlug);
        if (!args.MemberCollectiveId) {
          throw new Error(`No collective found with memberCollectiveSlug ${args.memberCollectiveSlug}`);
        }
      }

      const memberTable = args.MemberCollectiveId ? 'collective' : 'memberCollective';
      const attr = args.CollectiveId ? 'CollectiveId' : 'MemberCollectiveId';
      const where = { [attr]: args[attr] };
      if (args.role) {
        where.role = args.role.toUpperCase();
      }
      if (where.role === 'HOST') {
        where.HostCollectiveId = args.MemberCollectiveId;
      }

      if (['totalDonations', 'balance'].indexOf(args.orderBy) !== -1) {
        const queryName = args.orderBy === 'totalDonations' ? 'getMembersWithTotalDonations' : 'getMembersWithBalance';
        const tiersById = {};

        const options = args.isActive ? { ...args, limit: args.limit * 2 } : args;

        let results = await rawQueries[queryName](where, options);

        if (args.isActive) {
          const TierIds = uniq(results.map(r => r.dataValues.TierId));
          const tiers = await models.Tier.findAll({
            where: { id: { [Op.in]: TierIds } },
          });
          tiers.map(t => (tiersById[t.id] = t.dataValues));
          results = results
            .filter(r =>
              models.Member.isActive({
                tier: tiersById[r.dataValues.TierId],
                lastDonation: r.dataValues.lastDonation,
              }),
            )
            .slice(0, args.limit);
        }

        return Promise.map(results, collective => {
          const res = {
            id: collective.dataValues.MemberId,
            role: collective.dataValues.role,
            createdAt: collective.dataValues.createdAt,
            CollectiveId: collective.dataValues.CollectiveId,
            MemberCollectiveId: collective.dataValues.MemberCollectiveId,
            ParentCollectiveId: collective.dataValues.ParentCollectiveId,
            totalDonations: collective.dataValues.totalDonations,
            TierId: collective.dataValues.TierId,
          };
          res[memberTable] = collective;
          return res;
        });
      } else {
        const query = { where, include: [] };
        if (args.TierId) {
          query.where.TierId = args.TierId;
        }

        // If we request the data of the member, we do a JOIN query
        // that allows us to sort by Member.member.name
        const memberCond = {};
        if (req.body.query.match(/ member ?\{/) || args.type) {
          if (args.type) {
            const types = args.type.split(',');
            memberCond.type = { [Op.in]: types };
          }
          query.include.push({
            model: models.Collective,
            as: memberTable,
            required: true,
            where: memberCond,
          });
          query.order = [[sequelize.literal(`"${memberTable}".name`), 'ASC']];
        }
        if (args.limit) {
          query.limit = args.limit;
        }
        if (args.offset) {
          query.offset = args.offset;
        }

        let collectiveIds;
        if (args.includeHostedCollectives) {
          const members = await models.Member.findAll({
            where: {
              MemberCollectiveId: args.CollectiveId,
              role: 'HOST',
            },
          });
          collectiveIds = members.map(members => members.CollectiveId);
        } else {
          collectiveIds = [args[attr]];
        }

        query.where[attr] = { [Op.in]: collectiveIds };
        query.where.role = { [Op.ne]: 'HOST' };
        const members = await models.Member.findAll(query);

        // also fetch the list of collectives that are members of the host
        if (args.includeHostedCollectives) {
          query.where = {
            MemberCollectiveId: args.CollectiveId,
            role: 'HOST',
          };
          query.order = [[sequelize.literal('collective.name'), 'ASC']];
          query.include = [
            {
              model: models.Collective,
              as: 'collective',
              required: true,
            },
          ];
          const hostedMembers = await models.Member.findAll(query);
          await Promise.map(hostedMembers, m => {
            m.memberCollective = m.collective;
            delete m.collective;
            members.push(m);
          });
          return members;
        } else if (args.CollectiveId && !req.remoteUser?.isAdmin(args.CollectiveId)) {
          return members.filter(m => !m.collective?.isIncognito);
        } else {
          return members;
        }
      }
    },
  },

  memberInvitations: {
    type: new GraphQLList(MemberInvitationType),
    description: '[AUTHENTICATED] Returns the pending invitations',
    args: {
      CollectiveId: { type: GraphQLInt },
      MemberCollectiveId: { type: GraphQLInt },
    },
    resolve(collective, args, { remoteUser }) {
      if (!remoteUser) {
        throw new Forbidden('Only collective admins can see pending invitations');
      }
      if (!args.CollectiveId && !args.MemberCollectiveId) {
        throw new ValidationFailed('You must either provide a CollectiveId or a MemberCollectiveId');
      }

      // Must be an admin to see pending invitations
      const isAdminOfCollective = args.CollectiveId && remoteUser.isAdmin(args.CollectiveId);
      const isAdminOfMemberCollective = args.MemberCollectiveId && remoteUser.isAdmin(args.MemberCollectiveId);
      if (!isAdminOfCollective && !isAdminOfMemberCollective) {
        new Forbidden('Only collective admins can see pending invitations');
      }

      const where = {};
      if (args.CollectiveId) {
        where.CollectiveId = args.CollectiveId;
      }
      if (args.MemberCollectiveId) {
        where.MemberCollectiveId = args.MemberCollectiveId;
      }

      return models.MemberInvitation.findAll({
        where,
        include: [
          { association: 'collective', required: true, attributes: [] },
          { association: 'memberCollective', required: true, attributes: [] },
        ],
      });
    },
  },

  /*
   * Given a collective slug, returns all events
   */
  allEvents: {
    type: new GraphQLList(CollectiveInterfaceType),
    args: {
      slug: { type: GraphQLString, description: 'Slug of the parent collective' },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      isArchived: {
        type: GraphQLBoolean,
        description:
          'If null, returns all events, if false returns only events that are not archived, if true only returns events that have been archived',
      },
    },
    resolve(_, args) {
      const where = { type: 'EVENT' };
      if (args.slug) {
        if (args.isArchived === true) {
          where.deactivatedAt = { [Op.not]: null };
        }
        if (args.isArchived === false) {
          where.deactivatedAt = null;
        }
        return models.Collective.findBySlug(args.slug, { attributes: ['id'] })
          .then(collective => {
            where.ParentCollectiveId = collective.id;
            return models.Collective.findAll({
              where,
              order: [
                ['startsAt', 'DESC'],
                ['createdAt', 'DESC'],
              ],
              limit: args.limit || 10,
              offset: args.offset || 0,
            });
          })
          .catch(() => {
            return [];
          });
      } else {
        return models.Collective.findAll({ where });
      }
    },
  },

  /*
   * Given a prepaid code, return validity and amount
   */
  PaymentMethod: {
    type: PaymentMethodType,
    args: {
      id: { type: GraphQLInt },
      code: { type: GraphQLString },
    },
    resolve(_, args) {
      if (args.id) {
        return models.PaymentMethod.findByPk(args.id);
      } else if (args.code) {
        const redeemCodeRegex = /^[a-zA-Z0-9]{8}$/;
        if (!redeemCodeRegex.test(args.code)) {
          throw Error(`Code "${args.code}" has invalid format`);
        }

        return models.PaymentMethod.findOne({
          where: sequelize.and(
            sequelize.where(sequelize.cast(sequelize.col('uuid'), 'text'), {
              [Op.like]: `${args.code}%`,
            }),
            { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE },
            { type: PAYMENT_METHOD_TYPE.GIFTCARD },
          ),
        });
      } else {
        return new Error('Please provide an id or a code.');
      }
    },
  },

  /*
   * Given a search term, return a list of related Collectives
   */
  search: {
    type: CollectiveSearchResultsType,
    description: `Search for collectives. Results are returned with best matches first.`,
    args: {
      term: {
        type: GraphQLString,
        description: 'Fetch collectives related to this term based on name, description, tags, slug, and location',
      },
      hostCollectiveIds: {
        type: new GraphQLList(GraphQLInt),
        description: 'Limit the search to collectives under these hosts',
      },
      types: {
        type: new GraphQLList(TypeOfCollectiveType),
        description: 'Only return collectives of this type',
      },
      isHost: {
        type: GraphQLBoolean,
        description: 'Filter on whether account is a host',
      },
      onlyActive: {
        type: GraphQLBoolean,
        description: 'Whether to return only active accounts',
        deprecationReason: '2021-01-20: Not supported anymore.',
      },
      skipRecentAccounts: {
        type: GraphQLBoolean,
        description: 'Whether to skip recent accounts (48h)',
        defaultValue: false,
      },
      limit: {
        type: GraphQLInt,
        description: 'Limit the amount of results. Defaults to 20',
        defaultValue: 20,
      },
      offset: {
        type: GraphQLInt,
        defaultValue: 0,
      },
      useAlgolia: {
        type: GraphQLBoolean,
        deprecationReason: '2020-12-14: Algolia is intended to be removed in a near future',
        defaultValue: false,
        description: `This flag is now ignored in favor of regular search`,
      },
    },
    async resolve(_, args, req) {
      const { limit, offset, term, types, isHost, hostCollectiveIds, skipRecentAccounts } = args;
      const cleanTerm = term ? term.trim() : '';
      const listToStr = list => (list ? list.join('_') : '');
      const generateResults = (collectives, total) => {
        const optionalParamsKey = `${listToStr(types)}-${listToStr(hostCollectiveIds)}`;
        const skipRecentKey = skipRecentAccounts ? 'skipRecent' : 'all';
        return {
          id: `search-${optionalParamsKey}-${cleanTerm}-${skipRecentKey}-${offset}-${limit}`,
          total,
          collectives,
          limit,
          offset,
        };
      };

      if (isEmail(cleanTerm) && req.remoteUser && (!types || types.includes(CollectiveTypes.USER))) {
        // If an email is provided, search in the user table. Users must be authenticated
        // because we limit the rate of queries for this feature.
        const [collectives, total] = await searchCollectivesByEmail(cleanTerm, req.remoteUser);
        return generateResults(collectives, total);
      } else {
        const [collectives, total] = await searchCollectivesInDB(cleanTerm, offset, limit, {
          types,
          hostCollectiveIds,
          isHost,
          skipRecentAccounts,
        });
        return generateResults(collectives, total);
      }
    },
  },
  /** Gets the transactions of a payment method
   * @param {Object} args contains the parameters
   * @param {Number} args.uuid The Payment method id
   * @param {String} [args.type] The transaction type - Debit or Credit
   * @param {Number} [args.limit] The limit of records to be returned
   * @param {String} [args.offset] The offset of the query
   * @param {String} [args.dateFrom] The start date(field createdAt) to return the list of transactions
   * @param {String} [args.dateTo] The end date(field createdAt) to return the list of transactions
   * @returns {[models.Transaction]} returns an array of transactions.
   */
  allTransactionsFromPaymentMethod: {
    type: new GraphQLList(TransactionInterfaceType),
    deprecationReason: '2021-01-29: Not used anymore',
    args: {
      uuid: { type: new GraphQLNonNull(GraphQLString) },
      type: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      dateFrom: { type: GraphQLString },
      dateTo: { type: GraphQLString },
    },
    resolve: async (_, args) => {
      const paymentMethod = await models.PaymentMethod.findOne({
        where: { uuid: args.uuid },
      });
      if (!paymentMethod) {
        throw Error(`Payment Method with uuid ${args.uuid} not found.`);
      }
      const query = {
        where: {
          PaymentMethodId: paymentMethod.id,
        },
        order: [['createdAt', 'DESC']],
      };
      if (args.type) {
        query.where.type = args.type;
      }
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }

      if (args.dateFrom || args.dateTo) {
        query.where.createdAt = {};
        if (args.dateFrom) {
          query.where.createdAt[Op.gte] = args.dateFrom;
        }
        if (args.dateTo) {
          query.where.createdAt[Op.lte] = args.dateTo;
        }
      }
      const transactions = await models.Transaction.findAll(query);
      return transactions;
    },
  },

  Order: {
    type: OrderType,
    deprecationReason: '2021-01-29: Not used anymore',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    },
    resolve: async (_, args) => {
      const order = await models.Order.findByPk(args.id);
      return order;
    },
  },
};

export default queries;
