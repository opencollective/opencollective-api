import { expect } from 'chai';

import { getPostgresSearchAdapter } from '../../../../../../server/lib/search/providers/postgres/adapters';
import { runWithSearchBudget } from '../../../../../../server/lib/search/providers/postgres/execution';
import { parseSearchInput } from '../../../../../../server/lib/search/providers/postgres/input';
import { executeSearchQuery } from '../../../../../../server/lib/search/providers/postgres/query-builder';
import { SearchEntity, SearchEntityResult } from '../../../../../../server/lib/search/types';
import { fakeCollective, fakeOrder, fakeTransaction } from '../../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../../utils';

const search = (
  entity: SearchEntity.ORDERS | SearchEntity.TRANSACTIONS,
  term: string,
  page: { limit: number; offset: number; cap?: number; scoped?: boolean },
): Promise<SearchEntityResult> =>
  runWithSearchBudget({ deadline: Date.now() + 10_000 }, async trx => {
    const arms = getPostgresSearchAdapter(entity).buildArms(trx, {
      input: parseSearchInput(term),
      scope: { accountId: null, hostId: null },
      access: { forbidPrivate: false, isRoot: true, adminIds: [], deniedOAuthScopes: [] },
      params: {},
    });
    return executeSearchQuery(trx, arms, page);
  });

describe('server/lib/search/providers/postgres/query-builder', () => {
  before(async () => {
    await resetTestDB();
    const collective = await fakeCollective();
    // Exact descriptions are interleaved with partial ones, so that bands and IDs don't sort the same way
    for (let i = 0; i < 12; i++) {
      const description = i % 4 === 0 ? 'Ocelot grant' : `Ocelot grant ${i}`;
      await fakeTransaction({ CollectiveId: collective.id, description });
      await fakeOrder({ CollectiveId: collective.id, description });
    }
  });

  for (const entity of [SearchEntity.ORDERS, SearchEntity.TRANSACTIONS] as const) {
    describe(entity, () => {
      it('has constant scores per arm', () => {
        expect(getPostgresSearchAdapter(entity).constantScorePerArm).to.be.true;
      });

      it('returns the same pages and maxScore as the exact query, with a capped total', async () => {
        for (const [limit, offset] of [
          [5, 0],
          [5, 3],
          [5, 10],
          [0, 0],
          [50, 0],
        ]) {
          const exact = await search(entity, 'ocelot grant', { limit, offset });
          expect(exact.totalCount).to.eq(12);

          const uncapped = await search(entity, 'ocelot grant', { limit, offset, cap: 100 });
          expect(uncapped).to.deep.include({ totalCount: 12, totalCountIsCapped: false, maxScore: exact.maxScore });
          expect(uncapped.hits.map(hit => [hit.id, hit.score])).to.deep.eq(exact.hits.map(hit => [hit.id, hit.score]));

          const capped = await search(entity, 'ocelot grant', { limit, offset, cap: 4 });
          expect(capped).to.deep.include({ totalCount: 4, totalCountIsCapped: true, maxScore: exact.maxScore });
          expect(capped.hits.map(hit => hit.id)).to.deep.eq(exact.hits.map(hit => hit.id));

          // Scoped requests only change the plan (`id + 0`), not the results
          const scoped = await search(entity, 'ocelot grant', { limit, offset, cap: 4, scoped: true });
          expect(scoped).to.deep.eq(capped);
        }
      });

      it('counts exactly when the total is the cap', async () => {
        const result = await search(entity, 'ocelot grant', { limit: 1, offset: 0, cap: 12 });
        expect(result).to.deep.include({ totalCount: 12, totalCountIsCapped: false });
      });

      it('returns an empty result without matches', async () => {
        const result = await search(entity, 'nomatchword', { limit: 5, offset: 0, cap: 10 });
        expect(result).to.deep.eq({ totalCount: 0, totalCountIsCapped: false, maxScore: 0, hits: [] });
      });
    });
  }
});
