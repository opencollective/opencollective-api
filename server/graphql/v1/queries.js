import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { uniq } from 'lodash';
import { isEmail } from 'validator';

import { roles } from '../../constants';
import { CollectiveType } from '../../constants/collectives';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { fetchCollectiveId } from '../../lib/cache';
import logger from '../../lib/logger';
import { getConsolidatedInvoicesData } from '../../lib/pdf';
import rawQueries from '../../lib/queries';
import { searchCollectivesByEmail, searchCollectivesInDB } from '../../lib/sql-search';
import models, { Op, sequelize } from '../../models';
import { NotFound, Unauthorized } from '../errors';

import {
  CollectiveInterfaceType,
  CollectiveSearchResultsType,
  HostCollectiveOrderFieldType,
  TypeOfCollectiveType,
} from './CollectiveInterface';
import { TransactionInterfaceType } from './TransactionInterface';
import { InvoiceType, MemberType, OrderDirectionType, PaymentMethodType, TierType, UserType } from './types';

const queries = {
  // Still used by the collective page
  Collective: {
    type: CollectiveInterfaceType,
    deprecationReason: '2025-07-10: Please use GraphQL V2',
    args: {
      slug: { type: GraphQLString },
      id: { type: GraphQLInt },
      throwIfMissing: {
        type: GraphQLBoolean,
        defaultValue: true,
        description: 'If false, will return null instead of an error if collective is not found',
      },
    },
    resolve(_, args, req) {
      let collective;
      if (args.slug) {
        collective = models.Collective.findBySlug(args.slug.toLowerCase(), null, args.throwIfMissing);
      } else if (args.id) {
        collective = req.loaders.Collective.byId.load(args.id);
      } else {
        return new Error('Please provide a slug or an id');
      }
      if (!collective && args.throwIfMissing) {
        throw new NotFound('Collective not found');
      }
      return collective;
    },
  },

  // Still used by the tier page
  Tier: {
    type: TierType,
    deprecationReason: '2023-05-04: Please use GraphQL V2',
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args) {
      return models.Tier.findByPk(args.id);
    },
  },

  // The user menu & main LoggedInUser query in the frontend is still based on this
  LoggedInUser: {
    type: UserType,
    deprecationReason: '2025-07-10: Please use GraphQL V2',
    resolve(_, args, req) {
      return req.remoteUser;
    },
  },

  // Still used by Dashboard > "Payment Receipts"
  allInvoices: {
    type: new GraphQLList(InvoiceType),
    deprecationReason: '2025-07-10: Please use GraphQL V2',
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

  /*
   * Given a collective slug or id, returns all its transactions
   * Still used by the REST API v1 endpoints.
   */
  allTransactions: {
    type: new GraphQLList(TransactionInterfaceType),
    deprecationReason: '2025-07-10: Please use GraphQL V2',
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

  /*
   * Given a Transaction id, returns a transaction details
   * Still used by the REST API v1 endpoints.
   */
  Transaction: {
    type: TransactionInterfaceType,
    deprecationReason: '2025-07-10: Please use GraphQL V2',
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
   * Still used by "Create Gift Cards" form
   * Returns all hosts
   */
  allHosts: {
    type: CollectiveSearchResultsType,
    deprecationReason: '2025-07-10: Please use GraphQL V2',
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

  /*
   * Given a collective slug, returns all members/memberships
   * Still used by the images service + frontend widgets.
   */
  allMembers: {
    type: new GraphQLList(MemberType),
    deprecationReason: '2025-07-10: Please use GraphQL V2',
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

        return Promise.all(
          results.map(collective => {
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
          }),
        );
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
          await Promise.all(
            hostedMembers.map(m => {
              m.memberCollective = m.collective;
              delete m.collective;
              members.push(m);
            }),
          );
          return members;
        } else if (args.CollectiveId && !req.remoteUser?.isAdmin(args.CollectiveId)) {
          return members.filter(m => !m.collective?.isIncognito);
        } else {
          return members;
        }
      }
    },
  },

  /*
   * Given a prepaid code, return validity and amount
   * Still used by the "Update Payment Method" page + redeemed gift card page.
   */
  PaymentMethod: {
    type: PaymentMethodType,
    deprecationReason: '2025-07-10: Please use GraphQL V2',
    args: {
      id: { type: GraphQLInt },
      code: { type: GraphQLString },
    },
    async resolve(_, args, req) {
      if (args.id) {
        const paymentMethod = await models.PaymentMethod.findByPk(args.id, {
          include: [{ model: models.Collective, required: true }],
        });

        if (!paymentMethod || !req.remoteUser?.isAdminOfCollective(paymentMethod.Collective)) {
          return null;
        } else {
          return paymentMethod;
        }
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
   * Still used by the collective picker.
   */
  search: {
    type: CollectiveSearchResultsType,
    deprecationReason: '2025-07-10: Please use GraphQL V2',
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
      parentCollectiveIds: {
        type: new GraphQLList(GraphQLInt),
        description: 'Limit the search to collectives under these parent collectives',
      },
      types: {
        type: new GraphQLList(TypeOfCollectiveType),
        description: 'Only return collectives of this type',
      },
      isHost: {
        type: GraphQLBoolean,
        description: 'Filter on whether account is a host',
      },
      includeArchived: {
        type: GraphQLBoolean,
        description: 'Included collectives which are archived',
      },
      includeVendorsForHostId: {
        type: GraphQLInt,
        description: 'Included vendors for specific host ID',
      },
      vendorVisibleToAccountIds: {
        type: new GraphQLList(GraphQLInt),
        description: 'Only return vendors visible to given account ids',
      },
      skipRecentAccounts: {
        type: GraphQLBoolean,
        description: 'Whether to skip recent accounts (48h)',
        defaultValue: false,
      },
      skipGuests: {
        type: GraphQLBoolean,
        description: 'Whether to skip guest accounts',
        defaultValue: true,
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
    },
    async resolve(_, args, req) {
      const {
        limit,
        offset,
        term,
        types,
        isHost,
        hostCollectiveIds,
        parentCollectiveIds,
        skipRecentAccounts,
        skipGuests,
        includeArchived,
        includeVendorsForHostId,
        vendorVisibleToAccountIds,
      } = args;
      const cleanTerm = term ? term.trim() : '';
      logger.info(`Search Query: ${cleanTerm}`);
      const listToStr = list => (list ? list.join('_') : '');
      const generateResults = (collectives, total) => {
        const optionalParamsKey = `${listToStr(types)}-${listToStr(hostCollectiveIds)}-${listToStr(
          parentCollectiveIds,
        )}`;
        const skipRecentKey = skipRecentAccounts ? 'skipRecent' : 'all';
        const skipGuestsKey = skipGuests ? '-withGuests-' : '';
        return {
          id: `search-${optionalParamsKey}-${cleanTerm}${skipGuestsKey}-${skipRecentKey}-${offset}-${limit}`,
          total,
          collectives,
          limit,
          offset,
        };
      };

      if (isEmail(cleanTerm) && req.remoteUser && (!types || types.includes(CollectiveType.USER))) {
        // If an email is provided, search in the user table. Users must be authenticated
        // because we limit the rate of queries for this feature.
        const [collectives, total] = await searchCollectivesByEmail(cleanTerm, req.remoteUser);
        return generateResults(collectives, total);
      } else {
        const [collectives, total] = await searchCollectivesInDB(cleanTerm, offset, limit, {
          types,
          hostCollectiveIds,
          parentCollectiveIds,
          isHost,
          skipRecentAccounts,
          skipGuests,
          includeArchived,
          includeVendorsForHostId,
          vendorVisibleToAccountIds,
        });
        return generateResults(collectives, total);
      }
    },
  },
};

export default queries;
