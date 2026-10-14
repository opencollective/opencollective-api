/**
 * Accounts (`Collectives`) adapter for PostgreSQL search.
 *
 * Coverage (same as OpenSearch): name, slug, description, longDescription (HTML stripped), tags, website, and
 * legalName for administrators of the account, its parent or its host (or root).
 *
 * Arms (see `scores.ts` for bands):
 * - exact identifier: ID / `#ID`, public ID (`acc_...`), GraphQL ID
 * - exact label: normalized name equality, slug equality (`slug` or `@slug`)
 * - ordinary words: all words across permitted fields (stemming, accents/case folded)
 * - prefix: name/slug words starting with every input word (input of 2+ characters)
 * - typo: trigram similarity on the name (input of 3+ characters). This is a fallback that only applies when no
 *   Account in the same scope/filters has name or slug words starting with the input words, which keeps it from
 *   re-scanning the large candidate sets of common words that the prefix arm already matches.
 */

import { Kysely, RawBuilder, sql } from 'kysely';
import { isEmpty, isNil } from 'lodash';

import { IDENTIFIER_TYPES } from '../../../../../graphql/v2/identifiers';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity } from '../../../types';
import {
  AccountExpressions as Exp,
  normalizedValue,
  prefixTsQuery,
  unaccentedValue,
  wordsTsQuery,
} from '../expressions';
import { isPublicIdOfEntity, parseGraphQLIdentifier } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type AccountsContext = PostgresSearchContext<SearchEntity.ACCOUNTS>;

/** Eligibility + scope + entity filters, shared by every arm */
const getBaseConditions = ({ scope, params }: AccountsContext): RawBuilder<unknown>[] => {
  const conditions: RawBuilder<unknown>[] = [sql.raw(Exp.eligible)];
  if (scope.accountId) {
    conditions.push(sql`(id = ${scope.accountId} OR "ParentCollectiveId" = ${scope.accountId})`);
  }
  if (scope.hostId) {
    conditions.push(sql`("isActive" = TRUE AND "HostCollectiveId" = ${scope.hostId})`);
  }
  if (params.type) {
    conditions.push(sql`type = ${params.type}`);
  }
  if (!isNil(params.isHost)) {
    conditions.push(sql`"hasMoneyManagement" = ${params.isHost}`);
  }
  if (!isNil(params.tags) && !isEmpty(params.tags)) {
    conditions.push(sql`tags && ${params.tags}::varchar[]`);
  }

  return conditions;
};

/**
 * Restricted fields (legalName) are only searchable by root and by administrators of the account, its parent or its
 * host. Returns one condition per permission branch: each one becomes its own arm, so that the planner can drive
 * it with a single-column index instead of filtering every text match with an OR.
 */
const getRestrictedFieldsPermissions = ({ access }: AccountsContext): RawBuilder<unknown>[] => {
  if (access.forbidPrivate) {
    return [];
  } else if (access.isRoot) {
    return [sql`TRUE`];
  } else if (!access.adminIds.length) {
    return [];
  } else {
    const ids = sql`${access.adminIds}::int[]`;
    return [
      sql`id = ANY(${ids})`,
      sql`"ParentCollectiveId" = ANY(${ids})`,
      sql`("isActive" = TRUE AND "HostCollectiveId" = ANY(${ids}))`,
    ];
  }
};

/** Cheap in-band signals from short columns only */
const getLexicalBonus = ({ input }: AccountsContext, extra?: RawBuilder<number>): RawBuilder<number> => {
  const slugBonus = input.slug ? sql`CASE WHEN starts_with(slug, ${input.slug}) THEN 200 ELSE 0 END` : sql`0`;
  const hostBonus = sql`CASE WHEN "hasMoneyManagement" THEN 50 ELSE 0 END`;
  return sql<number>`${slugBonus} + ${hostBonus}${extra ? sql` + ${extra}` : sql``}`;
};

const and = (conditions: RawBuilder<unknown>[]): RawBuilder<boolean> =>
  sql<boolean>`${sql.join(conditions, sql` AND `)}`;

export const AccountsAdapter: PostgresSearchAdapter<SearchEntity.ACCOUNTS> = {
  entity: SearchEntity.ACCOUNTS,
  buildArms(db: Kysely<DatabaseWithViews>, context: AccountsContext): SearchArm[] {
    const { input } = context;
    const base = getBaseConditions(context);
    const arm = (band: QualityBand, conditions: RawBuilder<unknown>[], lexicalBonus?: RawBuilder<number>) =>
      db
        .selectFrom('Collectives')
        .select([sql<number>`id`.as('id'), scoreExpression(band, { preferred: true, lexicalBonus }).as('score')])
        .where(and([...base, ...conditions])) as SearchArm;

    const arms: SearchArm[] = [];

    // Exact identifiers
    const ids = [input.identifiers.id, parseGraphQLIdentifier(input, IDENTIFIER_TYPES.ACCOUNT)].filter(Boolean);
    for (const id of new Set(ids)) {
      arms.push(arm(QualityBand.EXACT_IDENTIFIER, [sql`id = ${id}`]));
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.Collective)) {
      arms.push(arm(QualityBand.EXACT_IDENTIFIER, [sql`"publicId" = ${input.identifiers.publicId}`]));
    }

    // Exact labels
    arms.push(
      arm(
        QualityBand.EXACT_LABEL,
        [sql`${sql.raw(Exp.normalizedName)} = ${normalizedValue(input.term)}`],
        getLexicalBonus(context),
      ),
    );
    if (input.slug) {
      arms.push(arm(QualityBand.EXACT_LABEL, [sql`slug = ${input.slug}`], getLexicalBonus(context)));
    }

    // Ordinary words, on public fields and (when permitted) public + restricted fields
    const words = wordsTsQuery(input.term);
    arms.push(arm(QualityBand.WORDS, [sql`${sql.raw(Exp.publicVector)} @@ ${words}`], getLexicalBonus(context)));
    for (const permission of getRestrictedFieldsPermissions(context)) {
      arms.push(
        arm(
          QualityBand.WORDS,
          [sql.raw(Exp.restrictedPredicate), sql`${sql.raw(Exp.restrictedVector)} @@ ${words}`, permission],
          getLexicalBonus(context),
        ),
      );
    }

    // Name/slug prefixes
    if (input.prefixQuery) {
      const prefixCondition = sql`${sql.raw(Exp.labelVector)} @@ ${prefixTsQuery(input.prefixQuery)}`;
      arms.push(arm(QualityBand.ACCOUNT_PREFIX, [prefixCondition], getLexicalBonus(context)));

      // Name typos, as a fallback when nothing matches as a prefix
      if (input.allowTypos) {
        const term = unaccentedValue(input.term);
        const similarity = sql<number>`(word_similarity(${term}, ${sql.raw(Exp.unaccentedName)}) * 200)::int`;
        arms.push(
          arm(
            QualityBand.ACCOUNT_TYPO,
            [
              sql`${term} <% ${sql.raw(Exp.unaccentedName)}`,
              sql`NOT EXISTS (SELECT 1 FROM "Collectives" WHERE ${and([...base, prefixCondition])})`,
            ],
            getLexicalBonus(context, similarity),
          ),
        );
      }
    }

    return arms;
  },
};
