import { GraphQLInt, GraphQLList, GraphQLBoolean } from 'graphql';

import { MemberOfCollection } from '../collection/MemberCollection';
import { AccountType, AccountTypeToModelMapping } from '../enum/AccountType';
import { MemberRole } from '../enum/MemberRole';

import models, { Op } from '../../../models';

export const IsMemberOfFields = {
  memberOf: {
    type: MemberOfCollection,
    args: {
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      role: { type: new GraphQLList(MemberRole) },
      accountType: { type: new GraphQLList(AccountType) },
      includeIncognito: {
        type: GraphQLBoolean,
        defaultValue: true,
        description:
          'Wether incognito profiles should be included in the result. Only works if requesting user is an admin of the account.',
      },
    },
    async resolve(collective, args, req) {
      const where = { MemberCollectiveId: collective.id };

      if (args.role && args.role.length > 0) {
        where.role = { [Op.in]: args.role };
      }
      const collectiveConditions = { deletedAt: null };
      if (args.accountType && args.accountType.length > 0) {
        collectiveConditions.type = {
          [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
        };
      }
      if (!args.includeIncognito || !req.remoteUser?.isAdmin(collective.id)) {
        collectiveConditions.isIncognito = false;
      }
      const result = await models.Member.findAndCountAll({
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

      return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
    },
  },
};
