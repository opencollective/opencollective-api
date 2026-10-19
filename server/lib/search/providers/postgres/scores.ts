/**
 * Shared score encoding for PostgreSQL search. Scores are comparable across entities: consumers can sort groups
 * (and hits) by score.
 *
 *   score = band * 1000 + (preferred entity ? 500 : 0) + lexical bonus (0..499)
 *
 * - The quality band always wins: an exact Update title (4000+) beats a partial Account name match (3500+).
 * - Within a band, Accounts are preferred: an exact Account name (4500+) beats an exact Update title (4000+).
 * - The lexical bonus is bounded and only computed from cheap signals on short fields; it never crosses bands.
 * - Ties are broken by descending ID (see `query-builder.ts`).
 */

import { RawBuilder, sql } from 'kysely';

export enum QualityBand {
  ACCOUNT_TYPO = 1,
  ACCOUNT_PREFIX = 2,
  WORDS = 3,
  EXACT_LABEL = 4,
  EXACT_IDENTIFIER = 5,
}

const BAND_SIZE = 1000;
const PREFERRED_ENTITY_BONUS = 500;
const MAX_LEXICAL_BONUS = 499;

/**
 * SQL score expression for an arm. `lexicalBonus` must be a cheap expression; it is clamped to its range.
 */
export const scoreExpression = (
  band: QualityBand,
  { preferred = false, lexicalBonus }: { preferred?: boolean; lexicalBonus?: RawBuilder<number> } = {},
): RawBuilder<number> => {
  const base = band * BAND_SIZE + (preferred ? PREFERRED_ENTITY_BONUS : 0);
  if (!lexicalBonus) {
    return sql<number>`${sql.lit(base)}`;
  }

  return sql<number>`${sql.lit(base)} + least(greatest((${lexicalBonus})::int, 0), ${sql.lit(MAX_LEXICAL_BONUS)})`;
};
