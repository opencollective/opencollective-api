import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { cloneDeep, invert, isNil } from 'lodash';

import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import { buildSearchConditions } from '../../../lib/search';
import models, { Op, sequelize } from '../../../models';
import { checkScope } from '../../common/scope-check';
import { ValidationFailed } from '../../errors';
import { GraphQLMemberOfCollection } from '../collection/MemberCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../enum/AccountType';
import { GraphQLHostFeeStructure } from '../enum/HostFeeStructure';
import { GraphQLMemberRole } from '../enum/MemberRole';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLOrderByInput, ORDER_BY_PSEUDO_FIELDS } from '../input/OrderByInput';

export const IsMemberOfFields = {
  memberOf: {
    type: new GraphQLNonNull(GraphQLMemberOfCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 150 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
      role: { type: new GraphQLList(GraphQLMemberRole) },
      accountType: { type: new GraphQLList(GraphQLAccountType) },
      account: { type: GraphQLAccountReferenceInput },
      isHostAccount: {
        type: GraphQLBoolean,
        description: 'Filter on whether the account is a host or not',
      },
      isApproved: {
        type: GraphQLBoolean,
        description: 'Filter on (un)approved collectives',
      },
      isArchived: {
        type: GraphQLBoolean,
        description: 'Filter on archived collectives',
      },
      includeIncognito: {
        type: GraphQLBoolean,
        defaultValue: true,
        description:
          'Whether incognito profiles should be included in the result. Only works if requesting user is an admin of the account.',
      },
      searchTerm: {
        type: GraphQLString,
        description:
          'A term to search membership. Searches in collective tags, name, slug, members description and role.',
      },
      hostFeesStructure: {
        type: GraphQLHostFeeStructure,
        description: 'Filters on the Host fees structure applied to this account',
      },
      orderBy: {
        type: new GraphQLNonNull(GraphQLOrderByInput),
        description: 'Order of the results',
        defaultValue: { field: ORDER_BY_PSEUDO_FIELDS.CREATED_AT, direction: 'DESC' },
      },
      orderByRoles: {
        type: GraphQLBoolean,
        description: 'Order the query by requested role order',
      },
    },
    async resolve(collective, args, req) {
      // Check Pagination arguments
      if (isNil(args.limit) || args.limit < 0) {
        args.limit = 100;
      }
      if (isNil(args.offset) || args.offset < 0) {
        args.offset = 0;
      }
      if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
        throw new Error('Cannot fetch more than 1,000 members at the same time, please adjust the limit');
      }

      const where = { MemberCollectiveId: collective.id, CollectiveId: { [Op.ne]: collective.id } };
      const collectiveConditions = {};

      if (!isNil(args.isApproved)) {
        collectiveConditions.approvedAt = { [args.isApproved ? Op.not : Op.is]: null };
      }
      if (!isNil(args.isArchived)) {
        collectiveConditions.deactivatedAt = { [args.isArchived ? Op.not : Op.is]: null };
      }

      // We don't want to apply the other filters for fetching the existing roles
      const existingRolesCollectiveConditions = cloneDeep(collectiveConditions);

      if (args.role && args.role.length > 0) {
        where.role = { [Op.in]: args.role };
      }
      if (args.accountType && args.accountType.length > 0) {
        collectiveConditions.type = {
          [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
        };
      }
      if (args.account) {
        const account = await fetchAccountWithReference(args.account, { loaders: req.loaders });
        where.CollectiveId = account.id;
      }
      if (!args.includeIncognito || !req.remoteUser?.isAdmin(collective.id) || !checkScope(req, 'incognito')) {
        collectiveConditions.isIncognito = false;
      }
      if (!isNil(args.isHostAccount)) {
        collectiveConditions.isHostAccount = args.isHostAccount;
      }

      if (args.hostFeesStructure) {
        if (args.hostFeesStructure === HOST_FEE_STRUCTURE.DEFAULT) {
          collectiveConditions.data = { useCustomHostFee: { [Op.not]: true } };
        } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.CUSTOM_FEE) {
          collectiveConditions.data = { useCustomHostFee: true };
        } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.MONTHLY_RETAINER) {
          throw new ValidationFailed('The MONTHLY_RETAINER fees structure is not supported yet');
        }
      }

      const searchTermConditions = buildSearchConditions(args.searchTerm, {
        idFields: ['id', '$collective.id$'],
        slugFields: ['$collective.slug$'],
        textFields: ['$collective.name$', '$collective.description$', 'description', 'role'],
        stringArrayFields: ['$collective.tags$'],
        stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
        castStringArraysToVarchar: true,
      });

      if (searchTermConditions.length) {
        where[Op.or] = searchTermConditions;
      }

      const order = [];
      const collectiveAttributesInclude = [];
      if (args.orderByRoles && args.role) {
        order.push(...args.role.map(r => sequelize.literal(`role='${r}' DESC`)));
      }
      if (args.orderBy) {
        const { field, direction } = args.orderBy;
        if (field === ORDER_BY_PSEUDO_FIELDS.MEMBER_COUNT) {
          order.push([sequelize.literal('"collective.memberCount"'), 'DESC']);
          collectiveAttributesInclude.push([
            sequelize.literal(`(
                    SELECT COUNT(*)
                    FROM "Members" AS "collective->members"
                    WHERE
                        "collective->members"."CollectiveId" = collective.id
                        AND "collective->members".role = 'BACKER'
                        AND "collective->members"."MemberCollectiveId" IS NOT NULL
                        AND "collective->members"."deletedAt" IS NULL
                )`),
            'memberCount',
          ]);
        } else if (field === ORDER_BY_PSEUDO_FIELDS.TOTAL_CONTRIBUTED) {
          order.push([sequelize.literal('"collective.totalAmountDonated"'), 'DESC']);
          collectiveAttributesInclude.push([
            sequelize.literal(`(
                    SELECT COALESCE(SUM("amount"), 0)
                    FROM "Transactions" AS "collective->transactions"
                    WHERE
                        "collective->transactions"."CollectiveId" = collective.id
                        AND "collective->transactions"."deletedAt" IS NULL
                        AND "collective->transactions"."type" = 'CREDIT'
                        AND (
                          "collective->transactions"."FromCollectiveId" = ${collective.id}
                          OR "collective->transactions"."UsingGiftCardFromCollectiveId" = ${collective.id}
                        )
                )`),
            'totalAmountDonated',
          ]);
        } else if (field === ORDER_BY_PSEUDO_FIELDS.CREATED_AT) {
          order.push(['createdAt', direction]);
        } else {
          order.push([field, direction]);
        }
      }

      const result = await models.Member.findAndCountAll({
        where,
        limit: args.limit,
        offset: args.offset,
        order,
        include: [
          {
            model: models.Collective,
            as: 'collective',
            where: collectiveConditions,
            required: true,
            attributes: {
              include: collectiveAttributesInclude,
            },
          },
        ],
      });

      return {
        nodes: result.rows,
        totalCount: result.count,
        limit: args.limit,
        offset: args.offset,
        roles: () =>
          models.Member.findAll({
            attributes: ['role', 'collective.type'],
            where: { MemberCollectiveId: collective.id, CollectiveId: { [Op.ne]: collective.id } },
            include: [
              {
                model: models.Collective,
                as: 'collective',
                required: true,
                attributes: ['type'],
                where: existingRolesCollectiveConditions,
              },
            ],
            group: ['role', 'collective.type'],
            raw: true,
          }).then(results =>
            results.map(m => ({
              role: m.role,
              type: invert(AccountTypeToModelMapping)[m.type],
            })),
          ),
      };
    },
  },
};
