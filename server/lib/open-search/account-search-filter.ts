import { getKysely } from '../kysely';

import { User } from '../../models';

type AccountSearchHit = {
  indexName: string;
  score: number;
  id: string;
  source: Record<string, unknown>;
  highlight: Record<string, string[]>;
};

type AccountSearchResult = {
  count: number;
  maxScore: number;
  hits: AccountSearchHit[];
};

/**
 * Returns the subset of individual (USER) collective IDs that the viewer is allowed to see in search.
 * Mirrors the scoping used by the Community / People tool (`AdminCommunityActivitySummary`).
 */
export const getSearchableIndividualCollectiveIds = async (
  candidateUserCollectiveIds: number[],
  remoteUser: User | null,
): Promise<Set<number>> => {
  if (!candidateUserCollectiveIds.length) {
    return new Set();
  }

  if (!remoteUser) {
    return new Set();
  }

  if (remoteUser.isRoot()) {
    return new Set(candidateUserCollectiveIds);
  }

  const adminOfAccountIds = remoteUser.getAdministratedCollectiveIds();
  const allowed = new Set<number>();

  for (const id of candidateUserCollectiveIds) {
    if (adminOfAccountIds.includes(id)) {
      allowed.add(id);
    }
  }

  const remainingIds = candidateUserCollectiveIds.filter(id => !allowed.has(id));
  if (!remainingIds.length || !adminOfAccountIds.length) {
    return allowed;
  }

  const db = getKysely();
  const rows = await db
    .selectFrom('AdminCommunityActivitySummary')
    .select('FromCollectiveId')
    .distinct()
    .where('FromCollectiveId', 'in', remainingIds)
    .where(({ eb, or }) =>
      or([eb('HostCollectiveId', 'in', adminOfAccountIds), eb('CollectiveId', 'in', adminOfAccountIds)]),
    )
    .execute();

  for (const row of rows) {
    if (row.FromCollectiveId) {
      allowed.add(row.FromCollectiveId);
    }
  }

  return allowed;
};

/**
 * Post-filter account search hits to hide individual profiles the viewer is not allowed to see.
 */
export const filterAccountSearchResults = async (
  result: AccountSearchResult,
  remoteUser: User | null,
): Promise<AccountSearchResult> => {
  const userHits = result.hits.filter(hit => hit.source['type'] === 'USER');
  if (!userHits.length) {
    return result;
  }

  const candidateIds = userHits.map(hit => Number(hit.source['id']));
  const allowedIds = await getSearchableIndividualCollectiveIds(candidateIds, remoteUser);

  const filteredHits = result.hits.filter(hit => {
    if (hit.source['type'] !== 'USER') {
      return true;
    }

    return allowedIds.has(Number(hit.source['id']));
  });

  const removedCount = result.hits.length - filteredHits.length;

  return {
    hits: filteredHits,
    count: Math.max(0, result.count - removedCount),
    maxScore: filteredHits.length ? Math.max(...filteredHits.map(hit => hit.score)) : 0,
  };
};
