import { GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import { intersection } from 'lodash';

import { types as CollectiveTypes } from '../../../constants/collectives';
import MemberRoles from '../../../constants/roles';
import models, { Op } from '../../../models';
import { checkScope } from '../../common/scope-check';
import { BadRequest } from '../../errors';
import { MemberCollection } from '../collection/MemberCollection';
import { AccountType, AccountTypeToModelMapping } from '../enum/AccountType';
import { MemberRole } from '../enum/MemberRole';
import { ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import MemberInvitationsQuery from '../query/MemberInvitationsQuery';
import EmailAddress from '../scalar/EmailAddress';

export const HasMembersFields = {
  members: {
    description: 'Get all members (admins, members, backers, followers)',
    type: new GraphQLNonNull(MemberCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
      role: { type: new GraphQLList(MemberRole) },
      accountType: { type: new GraphQLList(AccountType) },
      email: {
        type: EmailAddress,
        description: 'Admin only. To filter on the email address of a member, useful to check if a member exists.',
      },
      orderBy: {
        type: new GraphQLNonNull(ChronologicalOrderInput),
        defaultValue: { field: 'createdAt', direction: 'ASC' },
        description: 'Order of the results',
      },
    },
    async resolve(collective, args, req) {
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
      if ([CollectiveTypes.EVENT, CollectiveTypes.PROJECT].includes(collective.type)) {
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
