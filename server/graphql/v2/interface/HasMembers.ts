import type { Request } from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';
import { intersection, isNil, isUndefined } from 'lodash';
import { QueryTypes } from 'sequelize';

import { CollectiveType } from '../../../constants/collectives';
import MemberRoles, { MemberRolesForPrivateAccounts } from '../../../constants/roles';
import { assertCanSeeAccount } from '../../../lib/private-accounts';
import models, { type Collective, Op, sequelize } from '../../../models';
import { checkScope, isRemoteUserRoot } from '../../common/scope-check';
import { BadRequest } from '../../errors';
import { getMemberIsActiveSQLCondition } from '../../loaders/members';
import { GraphQLMemberCollection } from '../collection/MemberCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../enum/AccountType';
import { GraphQLMemberRole } from '../enum/MemberRole';
import { GraphQLOrderDirectionType } from '../enum/OrderDirectionType';
import { GraphQLChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput';
import MemberInvitationsQuery from '../query/MemberInvitationsQuery';
import EmailAddress from '../scalar/EmailAddress';

/**
 * Orders the members by the total amount they contributed to `collective` (same amount as `Member.totalDonations`).
 *
 * The totals are computed with a single aggregate over the account's transactions: a subquery per member is far too
 * slow on accounts with tens of thousands of backers (it times out after 2 minutes on production). The matching
 * members are fetched as plain rows (ids only), sorted here, and only the requested page is loaded.
 */
const getMembersOrderedByTotalContributed = async (
  collective: Collective,
  args: {
    limit: number;
    offset: number;
    orderByTotalContributed: 'ASC' | 'DESC';
    orderBy: { field: string; direction: string };
  },
  { where, memberCollectiveInclude, inheritedAttribute },
) => {
  const tieBreakField = args.orderBy.field;
  const candidates = (await models.Member.findAll({
    where,
    attributes: ['id', 'MemberCollectiveId', tieBreakField],
    include: [{ ...memberCollectiveInclude, attributes: [] }],
    raw: true,
  })) as unknown as Array<{ id: number; MemberCollectiveId: number } & Record<string, unknown>>;

  const totals = await sequelize.query<{ contributorId: number; total: string }>(
    `
    SELECT s."contributorId", SUM(s.amount) AS total
    FROM (
      SELECT t."FromCollectiveId" AS "contributorId", t.amount
      FROM "Transactions" t
      WHERE t."CollectiveId" = :collectiveId AND t."deletedAt" IS NULL AND t."type" = 'CREDIT'
      UNION ALL
      SELECT t."UsingGiftCardFromCollectiveId" AS "contributorId", t.amount
      FROM "Transactions" t
      WHERE t."CollectiveId" = :collectiveId AND t."deletedAt" IS NULL AND t."type" = 'CREDIT'
      AND t."UsingGiftCardFromCollectiveId" IS NOT NULL
      AND t."UsingGiftCardFromCollectiveId" != t."FromCollectiveId"
    ) s
    GROUP BY s."contributorId"
    `,
    { replacements: { collectiveId: collective.id }, type: QueryTypes.SELECT },
  );
  const totalByContributorId = new Map(totals.map(t => [Number(t.contributorId), Number(t.total)]));
  const getTotal = (member: { MemberCollectiveId: number }) => totalByContributorId.get(member.MemberCollectiveId) || 0;

  const totalSign = args.orderByTotalContributed === 'ASC' ? 1 : -1;
  const tieBreakSign = args.orderBy.direction === 'DESC' ? -1 : 1;
  candidates.sort((a, b) => {
    const totalDiff = getTotal(a) - getTotal(b);
    if (totalDiff !== 0) {
      return totalSign * totalDiff;
    }
    const aValue = a[tieBreakField] as Date | number;
    const bValue = b[tieBreakField] as Date | number;
    if (aValue < bValue) {
      return -tieBreakSign;
    } else if (aValue > bValue) {
      return tieBreakSign;
    }
    return a.id - b.id;
  });

  const pageIds = candidates.slice(args.offset, args.offset + args.limit).map(m => m.id);
  const pageMembers = pageIds.length
    ? await models.Member.findAll({
        where: { id: pageIds },
        attributes: { include: [inheritedAttribute] },
        include: [{ model: models.Collective, as: 'memberCollective' }],
      })
    : [];
  const membersById = new Map(pageMembers.map(m => [m.id, m]));

  return {
    nodes: pageIds.map(id => membersById.get(id)).filter(Boolean),
    totalCount: candidates.length,
    limit: args.limit,
    offset: args.offset,
  };
};

export const HasMembersFields = {
  members: {
    description: 'Get all members (admins, members, backers)',
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
      orderByTotalContributed: {
        type: GraphQLOrderDirectionType,
        description:
          'Order by the total amount each member contributed to this account. Takes precedence over `orderBy`, which is used to break ties.',
      },
      isActive: {
        type: GraphQLBoolean,
        description:
          'Only return active (true) or inactive (false) members, as defined by `Member.isActive`: members of a monthly or yearly tier need a recent contribution.',
      },
      includeInherited: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
      tier: {
        type: GraphQLTierReferenceInput,
        description: 'Filter members by tier. Pass null to filter for members without any tier.',
      },
    },
    async resolve(collective: Collective, args, req: Request) {
      await assertCanSeeAccount(req, collective);

      // Check Pagination arguments
      if (isNil(args.limit) || args.limit < 0) {
        args.limit = 100;
      }
      if (isNil(args.offset) || args.offset < 0) {
        args.offset = 0;
      }
      if (args.limit > 1000 && !isRemoteUserRoot(req)) {
        throw new Error('Cannot fetch more than 1,000 members at the same time, please adjust the limit');
      }

      // TODO: isn't it a better practice to return null?
      if (collective.isIncognito && (!req.remoteUser?.isAdmin(collective.id) || !checkScope(req, 'incognito'))) {
        return { offset: args.offset, limit: args.limit, totalCount: 0, nodes: [] };
      }

      let where: {
        CollectiveId?: number;
        role?: { [Op.in]: string[] };
        TierId?: number | { [Op.is]: null };
        [Op.or]?: [typeof where, { CollectiveId?: number; role?: { [Op.in]: string[] }; TierId?: number }];
        [Op.and]?: ReturnType<typeof sequelize.literal>[];
      } = { CollectiveId: collective.id };
      const collectiveInclude = [];

      if (args.role && args.role.length > 0) {
        where.role = { [Op.in]: args.role };
      }

      const collectiveConditions: {
        deletedAt?: null;
        isPrivate?: boolean;
        type?: { [Op.in]: string[] };
        [Op.or]?: Array<Record<string, unknown>>;
      } = { deletedAt: null, isPrivate: false };

      // Handle private accounts
      if (req.remoteUser) {
        if (isRemoteUserRoot(req)) {
          delete collectiveConditions.isPrivate;
        } else {
          const directAccess = Array.from(req.remoteUser.getCollectiveIdsForRoles(MemberRolesForPrivateAccounts));
          if (directAccess.length > 0) {
            delete collectiveConditions.isPrivate;
            collectiveConditions[Op.or] = [
              { isPrivate: false },
              { id: directAccess },
              { ParentCollectiveId: directAccess },
              { HostCollectiveId: directAccess },
            ];
          }
        }
      }

      if (args.accountType && args.accountType.length > 0) {
        collectiveConditions.type = {
          [Op.in]: [...new Set<string>(args.accountType.map((value): string => AccountTypeToModelMapping[value]))],
        };
      }

      // Filter by tier using TierReferenceInput
      if (!isUndefined(args.tier)) {
        if (args.tier) {
          const tier = await fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: true });
          if (tier.CollectiveId !== collective.id) {
            throw new BadRequest('Tier does not belong to this collective');
          }
          where.TierId = tier.id;
        } else {
          where.TierId = { [Op.is]: null };
        }
      }

      // Inherit Accountants and Admin from parent collective for Events and Projects
      if (args.includeInherited && [CollectiveType.EVENT, CollectiveType.PROJECT].includes(collective.type)) {
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

      if (!isNil(args.isActive)) {
        const isActiveCondition = getMemberIsActiveSQLCondition('Member');
        where = {
          ...where,
          [Op.and]: [sequelize.literal(args.isActive ? isActiveCondition : `NOT ${isActiveCondition}`)],
        };
      }

      const memberCollectiveInclude = {
        model: models.Collective,
        as: 'memberCollective',
        where: collectiveConditions,
        include: collectiveInclude,
        required: true,
      };
      const inheritedAttribute: [ReturnType<typeof sequelize.literal>, string] = [
        sequelize.literal(`"Member"."CollectiveId" = ${collective.ParentCollectiveId || 0}`),
        'inherited',
      ];

      if (args.orderByTotalContributed) {
        return getMembersOrderedByTotalContributed(collective, args, {
          where,
          memberCollectiveInclude,
          inheritedAttribute,
        });
      }

      const result = await models.Member.findAndCountAll({
        where,
        limit: args.limit,
        offset: args.offset,
        order: [[args.orderBy.field, args.orderBy.direction]],
        attributes: { include: [inheritedAttribute] },
        include: [memberCollectiveInclude],
      });

      return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
    },
  },
  memberInvitations: MemberInvitationsQuery,
};
