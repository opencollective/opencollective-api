/**
 * Shared score encoding for PostgreSQL search. Scores are comparable across entities: consumers can sort groups
 * (and hits) by score.
 *
 *   score = band * 1000 + (preferred entity ? 500 : 0) + lexical bonus (0..499)
 *
 * - The quality band always wins: an exact Update title (4000+) beats a partial Account name match (3500+).
 * - Within a band, Accounts are preferred: an exact Account name (4500+) beats an exact Update title (4000+). Vendors
 *   are not preferred: an exact vendor name (4000+) ranks below an exact Organization name (4500+).
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
 * SQL score expression for an arm. `preferred` can be a cheap per-row condition. `lexicalBonus` must be a cheap
 * expression; it is clamped to its range.
 */
export const scoreExpression = (
  band: QualityBand,
  {
    preferred = false,
    lexicalBonus,
  }: { preferred?: boolean | RawBuilder<boolean>; lexicalBonus?: RawBuilder<number> } = {},
): RawBuilder<number> => {
  const isConstantPreference = typeof preferred === 'boolean';
  const base = band * BAND_SIZE + (isConstantPreference && preferred ? PREFERRED_ENTITY_BONUS : 0);
  const preferredBonus = isConstantPreference
    ? sql``
    : sql` + CASE WHEN (${preferred}) THEN ${sql.lit(PREFERRED_ENTITY_BONUS)} ELSE 0 END`;
  if (!lexicalBonus) {
    return sql<number>`${sql.lit(base)}${preferredBonus}`;
  }

  return sql<number>`${sql.lit(base)}${preferredBonus} + least(greatest((${lexicalBonus})::int, 0), ${sql.lit(MAX_LEXICAL_BONUS)})`;
};
