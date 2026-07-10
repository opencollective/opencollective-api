import { CollectiveType } from '../../constants/collectives';

export enum OpenSearchIndexName {
  COLLECTIVES = 'collectives',
  COMMENTS = 'comments',
  EXPENSES = 'expenses',
  UPDATES = 'updates',
  TRANSACTIONS = 'transactions',
  ORDERS = 'orders',
  TIERS = 'tiers',
  HOST_APPLICATIONS = 'host-applications',
}

export interface OpenSearchIndexParams extends Record<OpenSearchIndexName, Record<string, unknown>> {
  [OpenSearchIndexName.COLLECTIVES]: {
    type?: CollectiveType;
    isHost?: boolean;
    tags?: string[];
  };
}

/**
 * Cross-index score multipliers applied when returning search results.
 * BM25 scores are not comparable across indices; collectives get a higher multiplier
 * so account matches surface above related comments, expenses, and transactions.
 */
export const INDEX_SCORE_MULTIPLIERS: Partial<Record<OpenSearchIndexName, number>> = {
  [OpenSearchIndexName.COLLECTIVES]: 3,
};

export const normalizeSearchScore = (index: OpenSearchIndexName, score: number): number => {
  const multiplier = INDEX_SCORE_MULTIPLIERS[index] ?? 1;
  return score * multiplier;
};
