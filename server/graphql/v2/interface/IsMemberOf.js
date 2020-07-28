import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { isNil } from 'lodash';

import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import models, { Op, sequelize } from '../../../models';
import { ValidationFailed } from '../../errors';
import { MemberOfCollection } from '../collection/MemberCollection';
import { AccountType, AccountTypeToModelMapping } from '../enum/AccountType';
import { HostFeeStructure } from '../enum/HostFeeStructure';
import { MemberRole } from '../enum/MemberRole';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';

export const IsMemberOfFields = {
  memberOf: {
    type: MemberOfCollection,
    args: {
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      role: { type: new GraphQLList(MemberRole) },
      accountType: { type: new GraphQLList(AccountType) },
      isHostAccount: {
        type: GraphQLBoolean,
        description: 'Filter on whether the account is a host or not',
      },
      includeIncognito: {
        type: GraphQLBoolean,
        defaultValue: true,
        description:
          'Wether incognito profiles should be included in the result. Only works if requesting user is an admin of the account.',
      },
      searchTerm: {
        type: GraphQLString,
        description:
          'A term to search membership. Searches in collective tags, name, slug, members description and role.',
      },
      hostFeesStructure: {
        type: HostFeeStructure,
        description: 'Filters on the Host fees structure applied to this account',
      },
      orderBy: {
        type: new GraphQLNonNull(ChronologicalOrderInput),
        defaultValue: { field: 'createdAt', direction: 'ASC' },
        description: 'Order of the results',
      },
    },
    async resolve(collective, args, req) {
      const where = { MemberCollectiveId: collective.id };

      if (args.role && args.role.length > 0) {
        where.role = { [Op.in]: args.role };
      }
      const collectiveConditions = {};
      if (args.accountType && args.accountType.length > 0) {
        collectiveConditions.type = {
          [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
        };
      }
      if (!args.includeIncognito || !req.remoteUser?.isAdmin(collective.id)) {
        collectiveConditions.isIncognito = false;
      }
      if (!isNil(args.isHostAccount)) {
        collectiveConditions.isHostAccount = args.isHostAccount;
      }

      if (args.hostFeesStructure) {
        if (args.hostFeesStructure === HOST_FEE_STRUCTURE.DEFAULT) {
          collectiveConditions.hostFeePercent = { [Op.or]: [collective.hostFeePercent, null] };
        } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.CUSTOM_FEE) {
          collectiveConditions.hostFeePercent = { [Op.not]: null, [Op.ne]: collective.hostFeePercent };
        } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.MONTHLY_RETAINER) {
          throw new ValidationFailed('The MONTHLY_RETAINER fees structure is not supported yet');
        }
      }

      if (args.searchTerm) {
        const sanitizedTerm = args.searchTerm.replace(/(_|%|\\)/g, '\\$1');
        const ilikeQuery = `%${sanitizedTerm}%`;

        where[Op.or] = [
          { description: { [Op.iLike]: ilikeQuery } },
          { role: { [Op.iLike]: ilikeQuery } },
          { '$collective.slug$': { [Op.iLike]: ilikeQuery } },
          { '$collective.name$': { [Op.iLike]: ilikeQuery } },
          { '$collective.description$': { [Op.iLike]: ilikeQuery } },
          { '$collective.tags$': { [Op.overlap]: sequelize.cast([args.searchTerm.toLowerCase()], 'varchar[]') } },
        ];

        if (!isNaN(args.searchTerm)) {
          where[Op.or].push({ '$collective.id$': args.searchTerm });
        }
      }

      const result = await models.Member.findAndCountAll({
        where,
        limit: args.limit,
        offset: args.offset,
        order: [[args.orderBy.field, args.orderBy.direction]],
        include: [
          {
            model: models.Collective,
            as: 'collective',
            where: collectiveConditions,
            required: true,
          },
        ],
      });

      return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
    },
  },
};
