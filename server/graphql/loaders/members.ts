import DataLoader from 'dataloader';
import _, { groupBy, partition, uniq } from 'lodash';

import MemberRoles from '../../constants/roles';
import { Collective, Member, sequelize } from '../../models';

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

      const result = await sequelize.query(queries.join('UNION ALL'), {
        type: sequelize.QueryTypes.SELECT,
        replacements: {
          userCollectiveIds: userCollectives.map(collective => collective.id),
          otherCollectivesIds: otherCollectives.map(collective => collective.id),
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
    const adminsByCollective = await Member.findAll({
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

export const generateRemoteUserIsAdminOfHostedAccountLoader = req => {
  return new DataLoader(async (hostIds: number[]): Promise<boolean[]> => {
    if (!req.remoteUser) {
      return hostIds.map(() => false);
    }

    const results = await Member.findAll({
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
