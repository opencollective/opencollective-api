import assert from 'assert';

import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import { intersection, isNil } from 'lodash';
import { InferAttributes, WhereOptions } from 'sequelize';

import { CollectiveType } from '../../../../constants/collectives';
import MemberRoles from '../../../../constants/roles';
import models, { Op } from '../../../../models';
import { MemberModelInterface } from '../../../../models/Member';
import { checkScope } from '../../../common/scope-check';
import { BadRequest } from '../../../errors';
import { GraphQLMemberCollection } from '../../collection/MemberCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum/AccountType';
import { GraphQLMemberRole } from '../../enum/MemberRole';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { GraphQLChronologicalOrderInput } from '../../input/ChronologicalOrderInput';
import EmailAddress from '../../scalar/EmailAddress';

const MembersCollectionQuery = {
  description: 'Get all members (admins, members, backers, followers)',
  type: new GraphQLNonNull(GraphQLMemberCollection),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Host hosting the account',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Host hosting the account',
    },
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
  async resolve(_: void, args, req: Express.Request) {
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

    const where: WhereOptions<InferAttributes<MemberModelInterface>> & {
      [Op.and]: WhereOptions<InferAttributes<MemberModelInterface>>[];
    } = { [Op.and]: [] };

    if (args.role && args.role.length > 0) {
      where['role'] = args.role as MemberRoles[] | MemberRoles;
    }

    if (args.accountType && args.accountType.length > 0) {
      where['$memberCollective.type$'] = {
        [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
      };
      where['$memberCollective.deletedAt$'] = null;
    }

    if (args.account) {
      assert(!args.host, new BadRequest('Cannot use both "account" and "host" at the same time'));
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: false });
      if (account.isIncognito && (!req.remoteUser?.isAdmin(account.id) || !checkScope(req, 'incognito'))) {
        return { offset: args.offset, limit: args.limit, totalCount: 0, nodes: [] };
      }

      // Inherit Accountants and Admin from parent collective for Events and Projects
      if (args.includeInherited && [CollectiveType.EVENT, CollectiveType.PROJECT].includes(account.type)) {
        const inheritedRoles = [MemberRoles.ACCOUNTANT, MemberRoles.ADMIN, MemberRoles.MEMBER];
        where[Op.and].push({
          [Op.or]: [
            { CollectiveId: account.id },
            {
              CollectiveId: account.ParentCollectiveId,
              role: { [Op.in]: args.role ? intersection(args.role, inheritedRoles) : inheritedRoles },
            },
          ],
        });
      } else {
        where[Op.and].push({ CollectiveId: account.id });
      }

      if (args.email) {
        if (!req.remoteUser?.isAdminOfCollective(account)) {
          throw new BadRequest('Only admins can lookup for members using the "email" argument');
        } else {
          where['$memberCollective.user.email$'] = args.email.toLowerCase();
        }
      }
    } else if (args.host) {
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: false });
      if (!req.remoteUser?.isAdminOfCollective(host)) {
        throw new BadRequest('Only admins can lookup for members using the "host" argument');
      }
      where['$collective.HostCollectiveId$'] = host.id;
      where['$collective.approvedAt$'] = { [Op.not]: null };

      if (args.email) {
        where['$memberCollective.user.email$'] = args.email.toLowerCase();
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
          include: [{ association: 'user' }],
          required: true,
          attributes: [],
        },
        {
          model: models.Collective,
          as: 'collective',
          required: true,
          attributes: [],
        },
      ],
    });

    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

export default MembersCollectionQuery;
