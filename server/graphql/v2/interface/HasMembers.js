import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import { intersection, isNil } from 'lodash-es';

import { types as CollectiveTypes } from '../../../constants/collectives.js';
import MemberRoles from '../../../constants/roles.js';
import models, { Op, sequelize } from '../../../models/index.js';
import { checkScope } from '../../common/scope-check.js';
import { BadRequest } from '../../errors.js';
import { GraphQLMemberCollection } from '../collection/MemberCollection.js';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../enum/AccountType.js';
import { GraphQLMemberRole } from '../enum/MemberRole.js';
import { GraphQLChronologicalOrderInput } from '../input/ChronologicalOrderInput.js';
import MemberInvitationsQuery from '../query/MemberInvitationsQuery.js';
import EmailAddress from '../scalar/EmailAddress.js';

export const HasMembersFields = {
  members: {
    description: 'Get all members (admins, members, backers, followers)',
    type: new GraphQLNonNull(GraphQLMemberCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
      role: { type: new GraphQLList(GraphQLMemberRole) },
      accountType: { type: new GraphQLList(GraphQLAccountType) },
      email: {
        type: EmailAddress,
        description: 'Admin only. To filter on the email address of a member, useful to check if a member exists.',
      },
      orderBy: {
        type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
        defaultValue: { field: 'createdAt', direction: 'ASC' },
        description: 'Order of the results',
      },
      includeInherited: {
        type: GraphQLBoolean,
        defaultValue: true,
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

      // TODO: isn't it a better practice to return null?
      if (collective.isIncognito && (!req.remoteUser?.isAdmin(collective.id) || !checkScope(req, 'incognito'))) {
        return { offset: args.offset, limit: args.limit, totalCount: 0, nodes: [] };
      }

      let where = { CollectiveId: collective.id };
      const collectiveInclude = [];

      if (args.role && args.role.length > 0) {
        where.role = { [Op.in]: args.role };
      }
      const collectiveConditions = { deletedAt: null };
      if (args.accountType && args.accountType.length > 0) {
        collectiveConditions.type = {
          [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
        };
      }

      // Inherit Accountants and Admin from parent collective for Events and Projects
      if (args.includeInherited && [CollectiveTypes.EVENT, CollectiveTypes.PROJECT].includes(collective.type)) {
        const inheritedRoles = [MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER];
        where = {
          [Op.or]: [
            where,
            {
              CollectiveId: collective.ParentCollectiveId,
              role: { [Op.in]: args.role ? intersection(args.role, inheritedRoles) : inheritedRoles },
            },
          ],
        };
      }

      if (args.email) {
        if (!req.remoteUser?.isAdminOfCollective(collective)) {
          throw new BadRequest('Only admins can lookup for members using the "email" argument');
        } else {
          collectiveInclude.push({ association: 'user', required: true, where: { email: args.email.toLowerCase() } });
        }
      }

      const result = await models.Member.findAndCountAll({
        where,
        limit: args.limit,
        offset: args.offset,
        order: [[args.orderBy.field, args.orderBy.direction]],
        attributes: {
          include: [
            [sequelize.literal(`"Member"."CollectiveId" = ${collective.ParentCollectiveId || 0}`), 'inherited'],
          ],
        },
        include: [
          {
            model: models.Collective,
            as: 'memberCollective',
            where: collectiveConditions,
            include: collectiveInclude,
            required: true,
          },
        ],
      });

      return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
    },
  },
  memberInvitations: MemberInvitationsQuery,
};
