/**
 * Expenses adapter for PostgreSQL search.
 *
 * Coverage (same as OpenSearch): description, longDescription (HTML stripped), currency, status, item descriptions,
 * and the restricted private message, invoice information and reference for administrators of the expense's
 * account, its parent, its payee or its host (or root).
 *
 * An Expense matches when all the words of the input are found either across its permitted fields or within a single
 * live item. Words split between the Expense and an item, or between two items, don't match.
 *
 * Arms (see `scores.ts` for bands):
 * - exact identifier: ID / `#ID`, public ID (`ex_...`), an item's public ID (`ei_...`), GraphQL ID, and the
 *   reference (restricted)
 * - exact label: normalized description equality
 * - ordinary words: on public fields, on public + restricted fields (when permitted), and within one item. The item
 *   arm is driven by the item text index and deduplicated by Expense before joining, so it never scans the items of
 *   each candidate Expense.
 *
 * Every arm excludes deleted Expenses and the Expenses of deleted or private accounts (anti-join on the small set of
 * excluded Accounts, see `isOwnedByEligibleAccount`). Account-dependent scopes and permissions use small, indexed sets
 * of account IDs (children, hosted accounts): no arm looks up the account of every candidate. The host of an Expense is its own host, or the active host of its account when it has none
 * (same as OpenSearch).
 */

import { Kysely, RawBuilder, sql } from 'kysely';

import { IDENTIFIER_TYPES } from '../../../../../graphql/v2/identifiers';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity } from '../../../types';
import {
  ExpenseExpressions as Exp,
  ExpenseItemExpressions as ItemExp,
  isOwnedByEligibleAccount,
  normalizedValue,
  wordsTsQuery,
} from '../expressions';
import { isPublicIdOfEntity, parseGraphQLIdentifier } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import { resolveRestrictedAccess } from './access';
import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type ExpensesContext = PostgresSearchContext<SearchEntity.EXPENSES>;

const and = (conditions: RawBuilder<unknown>[]): RawBuilder<boolean> =>
  sql<boolean>`${sql.join(conditions, sql` AND `)}`;

/** The Expense's account is a child of one of `ids` (index `ParentCollectiveId`) */
const isForChildOf = (ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  sql<boolean>`"CollectiveId" IN (SELECT c.id FROM "Collectives" c WHERE c."ParentCollectiveId" = ANY(${ids}))`;

/**
 * The Expense's effective host is one of `ids`: its own host, or the active host of its account when it has none.
 * Hosted accounts come from the index `collectives_pg_search_hosted` (index-only).
 */
const isHostedBy = (ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  sql<boolean>`("HostCollectiveId" = ANY(${ids}) OR ("HostCollectiveId" IS NULL AND "CollectiveId" IN (SELECT c.id FROM "Collectives" c WHERE c."HostCollectiveId" = ANY(${ids}) AND c."isActive" = TRUE AND c."deletedAt" IS NULL)))`;

/** Eligibility + scopes, shared by every arm (columns of "Expenses") */
const getBaseConditions = ({ scope }: ExpensesContext): RawBuilder<unknown>[] => {
  const conditions: RawBuilder<unknown>[] = [sql.raw(Exp.eligible), isOwnedByEligibleAccount('Expenses.CollectiveId')];
  if (scope.accountId) {
    const accountId = sql`ARRAY[${scope.accountId}]::int[]`;
    conditions.push(
      sql`("CollectiveId" = ANY(${accountId}) OR "FromCollectiveId" = ANY(${accountId}) OR ${isForChildOf(accountId)})`,
    );
  }
  if (scope.hostId) {
    conditions.push(isHostedBy(sql`ARRAY[${scope.hostId}]::int[]`));
  }

  return conditions;
};

/**
 * Restricted fields (private message, invoice information, reference) are only searchable by root and by the
 * administrators of the Expense's account, its parent, its payee or its host. Returns null when not permitted.
 */
const getRestrictedFieldsPermission = ({ access }: ExpensesContext): RawBuilder<unknown> | null =>
  resolveRestrictedAccess<RawBuilder<unknown>>(access, {
    forRoot: sql`TRUE`,
    forAdmins: ids =>
      sql`("CollectiveId" = ANY(${ids}) OR "FromCollectiveId" = ANY(${ids}) OR ${isForChildOf(ids)} OR ${isHostedBy(ids)})`,
  });

/** Cheap in-band signal from a short, public description: does it start with the input? */
const startsWithInput = ({ input }: ExpensesContext): RawBuilder<boolean> =>
  sql<boolean>`starts_with(lower(description), lower(${input.term}))`;

/**
 * Lexical bonuses. Matches on the Expense itself always rank above matches on one of its items only; within each,
 * descriptions starting with the input rank first.
 */
const PARENT_MATCH_BONUS = 200;
const STARTS_WITH_INPUT_BONUS = 100;

export const ExpensesAdapter: PostgresSearchAdapter<SearchEntity.EXPENSES> = {
  entity: SearchEntity.EXPENSES,
  buildArms(db: Kysely<DatabaseWithViews>, context: ExpensesContext): SearchArm[] {
    const { input } = context;
    const base = getBaseConditions(context);
    const restrictedPermission = getRestrictedFieldsPermission(context);
    const arm = (band: QualityBand, conditions: RawBuilder<unknown>[], lexicalBonus?: RawBuilder<number>) =>
      db
        .selectFrom('Expenses')
        .select([sql<number>`id`.as('id'), scoreExpression(band, { lexicalBonus }).as('score')])
        .where(and([...base, ...conditions])) as SearchArm;

    const arms: SearchArm[] = [];

    // Exact identifiers
    const ids = [input.identifiers.id, parseGraphQLIdentifier(input, IDENTIFIER_TYPES.EXPENSE)].filter(Boolean);
    for (const id of new Set(ids)) {
      arms.push(arm(QualityBand.EXACT_IDENTIFIER, [sql`id = ${id}`]));
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.Expense)) {
      arms.push(arm(QualityBand.EXACT_IDENTIFIER, [sql`"publicId" = ${input.identifiers.publicId}`]));
    } else if (isPublicIdOfEntity(input, EntityShortIdPrefix.ExpenseItem)) {
      const itemPublicId = input.identifiers.publicId;
      arms.push(
        arm(QualityBand.EXACT_IDENTIFIER, [
          sql`id = ANY(ARRAY(SELECT "ExpenseId" FROM "ExpenseItems" WHERE "publicId" = ${itemPublicId} AND "deletedAt" IS NULL))`,
        ]),
      );
    }
    if (restrictedPermission) {
      arms.push(arm(QualityBand.EXACT_IDENTIFIER, [sql`reference = ${input.term}`, restrictedPermission]));
    }

    // Exact description
    const parentBonus = sql<number>`${sql.lit(PARENT_MATCH_BONUS)} + CASE WHEN ${startsWithInput(context)} THEN ${sql.lit(STARTS_WITH_INPUT_BONUS)} ELSE 0 END`;
    arms.push(
      arm(
        QualityBand.EXACT_LABEL,
        [sql`${sql.raw(Exp.normalizedDescription)} = ${normalizedValue(input.term)}`],
        parentBonus,
      ),
    );

    // All the words, across the Expense's public fields, and (when permitted) its public + restricted fields
    const words = wordsTsQuery(input.term);
    arms.push(arm(QualityBand.WORDS, [sql`${sql.raw(Exp.publicVector)} @@ ${words}`], parentBonus));
    if (restrictedPermission) {
      arms.push(
        arm(
          QualityBand.WORDS,
          [sql.raw(Exp.restrictedPredicate), sql`${sql.raw(Exp.restrictedVector)} @@ ${words}`, restrictedPermission],
          parentBonus,
        ),
      );
    }

    // All the words within one live item. Matching items (item text index) are grouped by Expense first, keeping
    // the best item's bonus, then each group looks up its live Expense by ID: one row per Expense, always driven by
    // the matching items. The lookup is a LATERAL subquery with `LIMIT 1` so that the planner can't flatten it and
    // scan the Expenses of a scope instead (measured: full index scan of every Expense for a host scope). The Expense
    // side is index-only (`expenses_pg_search_accounts`).
    const matchingItems = db
      .selectFrom('ExpenseItems')
      .select([
        'ExpenseId',
        sql<number>`max(CASE WHEN ${startsWithInput(context)} THEN ${sql.lit(STARTS_WITH_INPUT_BONUS)} ELSE 0 END)`.as(
          'bonus',
        ),
      ])
      .where(and([sql.raw(ItemExp.eligible), sql`${sql.raw(ItemExp.vector)} @@ ${words}`]))
      .groupBy('ExpenseId')
      .as('matching_items');
    arms.push(
      db
        .selectFrom(matchingItems)
        .innerJoinLateral(
          eb =>
            eb
              .selectFrom('Expenses')
              .select('Expenses.id')
              .whereRef('Expenses.id', '=', 'matching_items.ExpenseId')
              .where(and(base))
              .limit(1)
              .as('expense'),
          join => join.onTrue(),
        )
        .select([
          sql<number>`expense.id`.as('id'),
          scoreExpression(QualityBand.WORDS, { lexicalBonus: sql<number>`matching_items.bonus` }).as('score'),
        ]) as SearchArm,
    );

    return arms;
  },
};
