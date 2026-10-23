/**
 * Tiers adapter for PostgreSQL search.
 *
 * Coverage (same as OpenSearch): name, slug, description, longDescription (HTML stripped) and identifiers. Tiers are
 * public: every user, including unauthenticated ones, can search the tiers of live, non-private Accounts.
 *
 * Arms (see `scores.ts` for bands):
 * - exact identifier: ID / `#ID`, public ID (`tier_...`), GraphQL ID
 * - exact label: normalized name equality, slug equality (`slug` or `@slug`)
 * - ordinary words: all words across the searchable fields (stemming, accents/case folded)
 *
 * Owning Account rules: the Account must be live and not private (anti-join on the small set of excluded Accounts, see
 * `isOwnedByEligibleAccount`). Account scope = tiers of the Account and its children; host scope = tiers of Accounts
 * actively hosted by the host.
 */

import { Kysely, RawBuilder, sql } from 'kysely';

import { IDENTIFIER_TYPES } from '../../../../../graphql/v2/identifiers';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity } from '../../../types';
import {
  isInAccountScope,
  isInHostScope,
  isOwnedByEligibleAccount,
  normalizedValue,
  TierExpressions as Exp,
  wordsTsQuery,
} from '../expressions';
import { isPublicIdOfEntity, parseGraphQLIdentifier } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type TiersContext = PostgresSearchContext<SearchEntity.TIERS>;

/** Eligibility + scopes, shared by every arm */
const getBaseConditions = ({ scope }: TiersContext): RawBuilder<unknown>[] => {
  const conditions: RawBuilder<unknown>[] = [sql.raw(Exp.eligible), isOwnedByEligibleAccount('Tiers.CollectiveId')];
  if (scope.accountId) {
    conditions.push(isInAccountScope('CollectiveId', scope.accountId));
  }
  if (scope.hostId) {
    conditions.push(isInHostScope('CollectiveId', scope.hostId));
  }

  return conditions;
};

/** Cheap in-band signal from a short column only */
const getLexicalBonus = ({ input }: TiersContext): RawBuilder<number> =>
  input.slug ? sql<number>`CASE WHEN starts_with(slug, ${input.slug}) THEN 200 ELSE 0 END` : sql<number>`0`;

export const TiersAdapter: PostgresSearchAdapter<SearchEntity.TIERS> = {
  entity: SearchEntity.TIERS,
  buildArms(db: Kysely<DatabaseWithViews>, context: TiersContext): SearchArm[] {
    const { input } = context;
    const base = getBaseConditions(context);
    const arm = (band: QualityBand, condition: RawBuilder<unknown>, lexicalBonus?: RawBuilder<number>) =>
      db
        .selectFrom('Tiers')
        .select([sql<number>`id`.as('id'), scoreExpression(band, { lexicalBonus }).as('score')])
        .where(sql<boolean>`${sql.join([...base, condition], sql` AND `)}`) as SearchArm;

    const arms: SearchArm[] = [];

    // Exact identifiers
    const ids = [input.identifiers.id, parseGraphQLIdentifier(input, IDENTIFIER_TYPES.TIER)].filter(Boolean);
    for (const id of new Set(ids)) {
      arms.push(arm(QualityBand.EXACT_IDENTIFIER, sql`id = ${id}`));
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.Tier)) {
      arms.push(arm(QualityBand.EXACT_IDENTIFIER, sql`"publicId" = ${input.identifiers.publicId}`));
    }

    // Exact labels
    const lexicalBonus = getLexicalBonus(context);
    arms.push(
      arm(QualityBand.EXACT_LABEL, sql`${sql.raw(Exp.normalizedName)} = ${normalizedValue(input.term)}`, lexicalBonus),
    );
    if (input.slug) {
      arms.push(arm(QualityBand.EXACT_LABEL, sql`slug = ${input.slug}`, lexicalBonus));
    }

    // Ordinary words
    arms.push(arm(QualityBand.WORDS, sql`${sql.raw(Exp.vector)} @@ ${wordsTsQuery(input.term)}`, lexicalBonus));

    return arms;
  },
};
