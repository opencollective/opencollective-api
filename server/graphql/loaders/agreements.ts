import DataLoader from 'dataloader';

import { sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

export const generateTotalAccountHostAgreementsLoader = () =>
  new DataLoader<number, number>(async (collectiveIds: number[]) => {
    const results: { CollectiveId?: number; totalCount: number }[] = await sequelize.query(
      `
    SELECT a."CollectiveId", count(a.id) as "totalCount" FROM
    "Agreements" a
    JOIN "Collectives" c 
    ON a."CollectiveId" = c.id
    AND a."HostCollectiveId" = c."HostCollectiveId"
    WHERE a."deletedAt" IS NULL
    AND a."CollectiveId" IN (:collectiveIds)
    GROUP BY a."CollectiveId";
  `,
      {
        type: sequelize.QueryTypes.SELECT,
        raw: true,
        replacements: {
          collectiveIds,
        },
      },
    );

    return sortResultsSimple(collectiveIds, results, result => result.CollectiveId, {
      totalCount: 0,
    }).map(r => r.totalCount);
  });
