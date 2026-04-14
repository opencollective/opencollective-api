import DataLoader from 'dataloader';
import { flatten, groupBy, uniq, zipObject } from 'lodash';
import { QueryTypes } from 'sequelize';

import { SupportedCurrency } from '../../constants/currencies';
import { ContributorsCacheEntry, getContributorsForCollective } from '../../lib/contributors';
import models, { sequelize } from '../../models';

import { sortResultsSimple } from './helpers';

export type TotalContributedToHost = {
  CollectiveId: number;
  amount: number;
  currency: SupportedCurrency;
  HostCollectiveId: number;
  since: string;
};

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
  generateTotalContributedToHost: () =>
    new DataLoader<{ CollectiveId: number; HostId: number; since: string }, TotalContributedToHost, string>(
      async requests => {
        const baseQuery = `
            SELECT t."FromCollectiveId" as "CollectiveId", SUM (t."amountInHostCurrency") as amount, t."hostCurrency" as currency, t."HostCollectiveId", :since as since
            FROM "Transactions" t
            WHERE t."FromCollectiveId" IN (:CollectiveIds)
              AND t."HostCollectiveId" = :HostId
              AND t."createdAt" >= :since
              AND t.kind IN ('CONTRIBUTION', 'ADDED_FUNDS')
              AND t."deletedAt" IS NULL
              AND t."RefundTransactionId" IS NULL
            GROUP BY t."FromCollectiveId", t."HostCollectiveId", t."hostCurrency"
          `;

        const groups = groupBy(requests, r => `${r.HostId}:${r.since}`);
        const queries = Object.values(groups).map(group => {
          const { HostId, since } = group[0];
          const CollectiveIds = group.map(r => r.CollectiveId);
          return sequelize.query(baseQuery, {
            replacements: { CollectiveIds, HostId, since },
            type: QueryTypes.SELECT,
            raw: true,
          }) as Promise<TotalContributedToHost[]>;
        });

        const results = await Promise.all(queries).then(flatten);

        const keys = requests.map(({ CollectiveId, HostId, since }) => `${HostId}:${since}:${CollectiveId}`);
        const genKeyFromResult = (r: TotalContributedToHost) => `${r.HostCollectiveId}:${r.since}:${r.CollectiveId}`;
        return sortResultsSimple(keys, results, genKeyFromResult);
      },
      {
        cacheKeyFn: arg => `${arg.HostId}-${arg.since}-${arg.CollectiveId}`,
      },
    ),
};

export default loaders;
