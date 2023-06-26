import DataLoader from 'dataloader';

import { sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

export const generateTotalAccountHostAgreementsLoader = () =>
  new DataLoader<number, number>(async (collectiveIds: number[]) => {
    const results: { CollectiveId?: number; totalCount: number }[] = await sequelize.query(
      `
    SELECT c."id", count(a.id) as "totalCount"
    FROM "Collectives" c
    INNER JOIN "Agreements" a
      ON a."HostCollectiveId" = c."HostCollectiveId"
      AND (
        a."CollectiveId" = c.id
        OR (c."ParentCollectiveId" IS NOT NULL AND a."CollectiveId" = c."ParentCollectiveId")
      )
    WHERE a."deletedAt" IS NULL
    AND c."id" IN (:collectiveIds)
    GROUP BY c."id"
  `,
      {
        type: sequelize.QueryTypes.SELECT,
        raw: true,
        replacements: {
          collectiveIds,
        },
      },
    );

    return sortResultsSimple(collectiveIds, results, result => result.id, { totalCount: 0 }).map(r => r.totalCount);
  });
