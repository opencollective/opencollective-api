/**
 * Updates adapter for PostgreSQL search.
 *
 * Coverage (same as OpenSearch): title, slug and HTML body (tags stripped).
 *
 * Rows: live Updates of Accounts that are not deleted, not private and not hidden from search (even for root), with
 * index-only anti-joins on the small sets of excluded Accounts. Row permission (live, applied in every arm before
 * matching, counting and ranking): published public Updates for everyone; private or unpublished Updates for root and
 * administrators of the Account or its parent; private published Updates for administrators of its active host.
 *
 * Arms (see `scores.ts` for bands), each one split into a public and a restricted variant:
 * - exact identifier: ID / `#ID`, public ID (`upd_...`), GraphQL ID
 * - exact label: normalized title equality, slug equality
 * - ordinary words: all words across title, slug and body (stemming, accents/case folded)
 *
 * The lexical bonus only looks at the title (short): bodies are never ranked.
 */

import { Kysely, RawBuilder, sql } from 'kysely';

import { IDENTIFIER_TYPES } from '../../../../../graphql/v2/identifiers';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity } from '../../../types';
import {
  isInAccountScope,
  isInHostScope,
  isOwnedByAccountShownInSearch,
  isOwnedByEligibleAccount,
  normalizedValue,
  UpdateExpressions as Exp,
  wordsTsQuery,
} from '../expressions';
import { isPublicIdOfEntity, parseGraphQLIdentifier } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type UpdatesContext = PostgresSearchContext<SearchEntity.UPDATES>;

const and = (conditions: RawBuilder<unknown>[]): RawBuilder<boolean> =>
  sql<boolean>`${sql.join(conditions, sql` AND `)}`;

/** Eligibility + scopes, shared by every arm */
const getBaseConditions = ({ scope }: UpdatesContext): RawBuilder<unknown>[] => {
  const conditions: RawBuilder<unknown>[] = [
    sql.raw(Exp.eligible),
    isOwnedByEligibleAccount('Updates.CollectiveId'),
    isOwnedByAccountShownInSearch('Updates.CollectiveId'),
  ];
  if (scope.accountId) {
    conditions.push(isInAccountScope('CollectiveId', scope.accountId));
  }
  if (scope.hostId) {
    conditions.push(isInHostScope('CollectiveId', scope.hostId));
  }

  return conditions;
};

/**
 * One condition per row permission branch. Restricted (private or unpublished) Updates are only matched in arms that
 * AND the administrator predicate, which looks up the administered domain once (hashed subplans), never per row.
 * Same rules as `canSeeUpdate`: administrators of the Account (or its parent) see drafts, host administrators only
 * see published Updates.
 */
const getRowPermissions = ({ access }: UpdatesContext): RawBuilder<unknown>[] => {
  if (access.isRoot && !access.forbidPrivate) {
    return [sql`TRUE`];
  }

  const permissions: RawBuilder<unknown>[] = [sql.raw(Exp.publiclyVisible)];
  if (!access.forbidPrivate && access.adminIds.length) {
    const ids = sql`${access.adminIds}::int[]`;
    permissions.push(
      sql`NOT ${sql.raw(Exp.publiclyVisible)} AND ("CollectiveId" = ANY(${ids}) OR "CollectiveId" IN (SELECT c.id FROM "Collectives" c WHERE c."ParentCollectiveId" = ANY(${ids})) OR ("publishedAt" IS NOT NULL AND "CollectiveId" IN (SELECT c.id FROM "Collectives" c WHERE c."HostCollectiveId" = ANY(${ids}) AND c."isActive" = TRUE AND c."deletedAt" IS NULL)))`,
    );
  }

  return permissions;
};

/**
 * Cheap in-band signal from the title only: the title contains the input as typed (case-insensitive). Measured on
 * broad terms, `to_tsvector` on the title costs ~15 µs per matched row (more than the match itself), `strpos` ~1 µs.
 */
const getLexicalBonus = ({ input }: UpdatesContext): RawBuilder<number> =>
  sql<number>`CASE WHEN strpos(lower(title), lower(${input.term})) > 0 THEN 200 ELSE 0 END`;

export const UpdatesAdapter: PostgresSearchAdapter<SearchEntity.UPDATES> = {
  entity: SearchEntity.UPDATES,
  buildArms(db: Kysely<DatabaseWithViews>, context: UpdatesContext): SearchArm[] {
    const { input } = context;
    const base = getBaseConditions(context);
    const permissions = getRowPermissions(context);
    const arms: SearchArm[] = [];
    const addArms = (band: QualityBand, condition: RawBuilder<unknown>, lexicalBonus?: RawBuilder<number>) => {
      for (const permission of permissions) {
        arms.push(
          db
            .selectFrom('Updates')
            .select([sql<number>`id`.as('id'), scoreExpression(band, { lexicalBonus }).as('score')])
            .where(and([...base, condition, permission])) as SearchArm,
        );
      }
    };

    // Exact identifiers
    const ids = [input.identifiers.id, parseGraphQLIdentifier(input, IDENTIFIER_TYPES.UPDATE)].filter(Boolean);
    for (const id of new Set(ids)) {
      addArms(QualityBand.EXACT_IDENTIFIER, sql`id = ${id}`);
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.Update)) {
      addArms(QualityBand.EXACT_IDENTIFIER, sql`"publicId" = ${input.identifiers.publicId}`);
    }

    // Exact labels
    addArms(QualityBand.EXACT_LABEL, sql`${sql.raw(Exp.normalizedTitle)} = ${normalizedValue(input.term)}`);
    if (input.slug) {
      addArms(QualityBand.EXACT_LABEL, sql`slug = ${input.slug}`);
    }

    // Ordinary words
    addArms(QualityBand.WORDS, sql`${sql.raw(Exp.vector)} @@ ${wordsTsQuery(input.term)}`, getLexicalBonus(context));

    return arms;
  },
};
