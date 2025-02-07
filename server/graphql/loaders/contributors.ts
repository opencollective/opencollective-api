import DataLoader from 'dataloader';
import { compact, uniq, zipObject } from 'lodash';

import { SupportedCurrency } from '../../constants/currencies';
import { ContributorsCacheEntry, getContributorsForCollective } from '../../lib/contributors';
import models, { sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

const loaders = {
  forCollectiveId: (): DataLoader<number, ContributorsCacheEntry> =>
    new DataLoader(async collectiveIds => {
      const uniqueIds = uniq(collectiveIds);
      const collectives = await models.Collective.findAll({ where: { id: uniqueIds } });
      const sortedCollectives = uniqueIds.map(id => collectives.find(c => c.id === id));
      const allContributors = await Promise.all(
        sortedCollectives.map(collective => getContributorsForCollective(collective)),
      );
      const contributorsByIds = zipObject(uniqueIds, allContributors);
      const result = collectiveIds.map(id => contributorsByIds[id]);
      return result;
    }),

  totalContributedToHost: {
    buildLoader: ({
      since,
      hostId,
    }: {
      hostId: number;
      since: Date | string;
    }): DataLoader<
      number,
      { CollectiveId: number; amount: number; currency: SupportedCurrency; HostCollectiveId: number }
    > => {
      const key = compact([hostId, since]).join('-');
      if (!loaders.totalContributedToHost[key]) {
        loaders.totalContributedToHost[key] = new DataLoader(async (collectiveIds: number[]) => {
          const stats = await sequelize.query(
            `
            SELECT t."FromCollectiveId" as "CollectiveId", SUM (t."amountInHostCurrency") as amount, t."hostCurrency" as currency, t."HostCollectiveId"
            FROM "Transactions" t
            WHERE t."FromCollectiveId" IN (:collectiveIds)
              AND t.kind = 'CONTRIBUTION'
              AND t."HostCollectiveId" = :hostId
              AND t."deletedAt" IS NULL
              AND t."RefundTransactionId" IS NULL
              AND t."createdAt" >= :since
            GROUP BY t."FromCollectiveId", t."HostCollectiveId", t."hostCurrency"
            `,
            {
              replacements: {
                collectiveIds,
                since,
                hostId,
              },
              type: sequelize.QueryTypes.SELECT,
              raw: true,
            },
          );

          return sortResultsSimple(collectiveIds, stats, row => row.CollectiveId);
        });
      }

      return loaders.totalContributedToHost[key];
    },
  },
};

export type ContributorsLoaders = typeof loaders;

export default loaders;
