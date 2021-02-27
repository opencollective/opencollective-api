import { GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';

import models, { Op } from '../../../models';
import { MemberCollection } from '../collection/MemberCollection';
import { AccountType, AccountTypeToModelMapping } from '../enum/AccountType';
import { MemberRole } from '../enum/MemberRole';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';

export const HasMembersFields = {
  members: {
    description: 'Get all members (admins, members, backers, followers)',
    type: MemberCollection,
    args: {
      limit: { type: GraphQLInt, defaultValue: 100 },
      offset: { type: GraphQLInt, defaultValue: 0 },
      role: { type: new GraphQLList(MemberRole) },
      accountType: { type: new GraphQLList(AccountType) },
      orderBy: {
        type: new GraphQLNonNull(ChronologicalOrderInput),
        defaultValue: { field: 'createdAt', direction: 'ASC' },
        description: 'Order of the results',
      },
    },
    async resolve(collective, args, req) {
      if (collective.isIncognito && !req.remoteUser?.isAdmin(collective.id)) {
        return { offset: args.offset, limit: args.limit, totalCount: 0, nodes: [] };
      }

      const where = { CollectiveId: collective.id };

      if (args.role && args.role.length > 0) {
        where.role = { [Op.in]: args.role };
      }
      const collectiveConditions = { deletedAt: null };
      if (args.accountType && args.accountType.length > 0) {
        collectiveConditions.type = {
          [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
        };
      }

      const result = await models.Member.findAndCountAll({
        where,
        limit: args.limit,
        offset: args.offset,
        order: [[args.orderBy.field, args.orderBy.direction]],
        include: [
          {
            model: models.Collective,
            as: 'memberCollective',
            where: collectiveConditions,
          },
        ],
      });

      return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
    },
  },
};
