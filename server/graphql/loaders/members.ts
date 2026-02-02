import DataLoader from 'dataloader';
import _, { groupBy, keyBy, partition, remove, uniq } from 'lodash';
import { QueryTypes } from 'sequelize';

import MemberRoles from '../../constants/roles';
import models, { Collective, Member, sequelize, Tier } from '../../models';

export const generateAdminUsersEmailsForCollectiveLoader = () => {
  return new DataLoader(
    async (collectives: Collective[]) => {
      const [userCollectives, otherCollectives] = partition(collectives, collective => collective.type === 'USER');
      const queries = [];

      if (userCollectives.length > 0) {
        queries.push(`
          SELECT users."CollectiveId" AS "CollectiveId", users.email
          FROM "Users" users
          WHERE users."CollectiveId" IN (:userCollectiveIds)
          AND users."deletedAt" IS NULL
        `);
      }

      if (otherCollectives.length > 0) {
        queries.push(`
          SELECT member."CollectiveId" AS "CollectiveId", users.email
          FROM "Users" users
          INNER JOIN "Members" member ON member."MemberCollectiveId" = users."CollectiveId"
          WHERE member."CollectiveId" IN (:otherCollectivesIds)
          AND member.role = 'ADMIN'
          AND member."deletedAt" IS NULL
          AND users."deletedAt" IS NULL
        `);
      }

      const result = await sequelize.query<{ CollectiveId: number; email: string }>(queries.join('UNION ALL'), {
        type: QueryTypes.SELECT,
        replacements: {
          userCollectiveIds: [...new Set(userCollectives.map(collective => collective.id))],
          otherCollectivesIds: [...new Set(otherCollectives.map(collective => collective.id))],
        },
      });

      const resultByCollective = groupBy(result, 'CollectiveId');
      return collectives.map(collective => {
        if (resultByCollective[collective.id]) {
          return uniq(resultByCollective[collective.id].map(entry => entry.email));
        } else {
          return [];
        }
      });
    },
    {
      cacheKeyFn: (collective: Collective) => collective.id,
    },
  );
};

export const generateCountAdminMembersOfCollective = () => {
  return new DataLoader(async (collectiveIds: number[]): Promise<number[]> => {
    const adminsByCollective = await models.Member.findAll({
      group: ['CollectiveId'],
      attributes: ['CollectiveId', [sequelize.fn('COUNT', sequelize.col('MemberCollectiveId')), 'adminCount']],
      where: {
        role: MemberRoles.ADMIN,
        CollectiveId: collectiveIds,
      },
    });
    const result = _.keyBy(adminsByCollective, 'CollectiveId');
    return collectiveIds.map(collectiveId => (result[collectiveId]?.dataValues as any)?.adminCount || 0);
  });
};

export const generateMemberIsActiveLoader = (req: Express.Request) => {
  return new DataLoader(async (memberIds: number[]): Promise<boolean[]> => {
    const membersToProcess = (await req.loaders.Member.byId.loadMany(memberIds)) as Member[];
    const activeMemberIds = new Set<number>();

    // Members without tiers are always active
    const membersWithoutTiers = remove(membersToProcess, m => !m.TierId);
    membersWithoutTiers.forEach(m => activeMemberIds.add(m.id));

    // Otherwise, we need to look at the tier properties
    const allTierIds = membersToProcess.map(m => m.TierId);
    if (allTierIds.length > 0) {
      const tiers = (await req.loaders.Tier.byId.loadMany(membersToProcess.map(m => m.TierId))) as Tier[];
      const groupedTiers = keyBy(tiers, 'id');

      // Exclude people that are members of tiers without interval or with interval 'flexible'
      const membersWithoutIntervalRestriction = remove(
        membersToProcess,
        m => !groupedTiers[m.TierId]?.interval || groupedTiers[m.TierId].interval === 'flexible',
      );
      membersWithoutIntervalRestriction.forEach(m => activeMemberIds.add(m.id));

      // The members left all have a tier with a monthly or yearly interval, we need to check their last transaction
      if (membersToProcess.length) {
        // The query below uses a 45 days grace period because, when contributing for the 1st time after the 15th of the month,
        // the next charge date is set to the following month (to avoid charging twice in a short period of time). This also
        // adds a grace period in case the first payment fails.
        // See `getNextChargeAndPeriodStartDates`
        const results = await sequelize.query<{ id: number }>(
          `
          SELECT DISTINCT m.id
          FROM "Members" m
          INNER JOIN "Collectives" mc
            ON m."MemberCollectiveId" = mc."id"
            AND mc."deletedAt" IS NULL
          INNER JOIN "Orders" o
            ON mc."id" = o."FromCollectiveId"
            AND o."CollectiveId" = m."CollectiveId"
            AND o."TierId" = m."TierId"
            AND o."deletedAt" IS NULL
          INNER JOIN "Tiers" t ON o."TierId" = t."id" AND t."deletedAt" IS NULL
          INNER JOIN "Transactions" tr
            ON tr."deletedAt" IS NULL
            AND tr."OrderId" = o."id"
            AND tr."RefundTransactionId" IS NULL
            AND CASE
              WHEN t.interval = 'year' THEN tr."createdAt" >= NOW() - INTERVAL '1 year'
              WHEN t.interval = 'month' THEN tr."createdAt" >= NOW() - INTERVAL '45 days'
              ELSE FALSE
            END
          WHERE m.id IN (:membersIds)
          AND m."deletedAt" IS NULL
        `,
          {
            replacements: { membersIds: membersToProcess.map(m => m.id) },
            type: QueryTypes.SELECT,
          },
        );

        results.forEach(({ id }) => activeMemberIds.add(id));
      }
    }

    return memberIds.map(id => activeMemberIds.has(id));
  });
};

export const generateRemoteUserIsAdminOfHostedAccountLoader = req => {
  return new DataLoader(async (hostIds: number[]): Promise<boolean[]> => {
    if (!req.remoteUser) {
      return hostIds.map(() => false);
    }

    const results = await models.Member.findAll({
      attributes: ['collective.HostCollectiveId', [sequelize.fn('COUNT', 'Member.id'), 'MembersCount']],
      group: ['collective.HostCollectiveId'],
      raw: true,
      where: {
        role: MemberRoles.ADMIN,
        MemberCollectiveId: req.remoteUser.CollectiveId,
      },
      include: {
        association: 'collective',
        required: true,
        attributes: [],
        where: {
          HostCollectiveId: hostIds,
          isActive: true,
        },
      },
    });

    const groupedResults = groupBy(results, 'HostCollectiveId');
    return hostIds.map(id => Boolean(groupedResults[id] && (groupedResults[id][0] as any).MembersCount > 0));
  });
};

/**
 * A dataloader to check if a remote user is an indirect financial contributor of a collective,
 * aka he is an admin of an account that contributes to the collective.
 */
export const generateRemoteUserIsIndirectFinancialContributor = (req: Express.Request) => {
  return new DataLoader(async (collectiveIds: number[]): Promise<boolean[]> => {
    if (!req.remoteUser) {
      return collectiveIds.map(() => false);
    }

    const adminOfCollectiveIds = req.remoteUser.getAdministratedCollectiveIds();
    if (adminOfCollectiveIds.length === 0) {
      return collectiveIds.map(() => false);
    }

    const results = await models.Member.findAll({
      attributes: ['CollectiveId', [sequelize.fn('COUNT', 'Member.id'), 'MembersCount']],
      group: ['CollectiveId'],
      raw: true,
      where: {
        role: [MemberRoles.BACKER, MemberRoles.ATTENDEE],
        MemberCollectiveId: adminOfCollectiveIds,
        CollectiveId: collectiveIds,
      },
    });

    const groupedResults = keyBy(results, 'CollectiveId');
    return collectiveIds.map(id => groupedResults[id]?.['MembersCount'] > 0);
  });
};
