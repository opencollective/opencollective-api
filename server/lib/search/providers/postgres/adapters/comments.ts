/**
 * Comments adapter for PostgreSQL search.
 *
 * Coverage (same as OpenSearch): the HTML body as plain text (`oc_search_html_to_text`), and identifiers.
 *
 * Comments are restricted rows: only root and administrators can find them (no access, e.g. unauthenticated: nothing
 * to search, no query). Every arm applies, before matching, counting and ranking:
 * - eligibility (even for root): live Comment, its Account neither deleted nor private, a live commented entity
 *   (Expense, Conversation, Update, Order or Host Application, in the order `canSeeComment` resolves them) whose
 *   Account is neither deleted nor private, and only private notes on Orders (the only type allowed there).
 * - the OpenSearch row permission: administrators of the effective host see every Comment; administrators of the
 *   Comment's Account, its parent or its author see `COMMENT`s (never private notes).
 * - the commented entity's visibility (live, see `getParentVisibility`): e.g. Comments on drafts and private Updates
 *   are only found by the Update's administrators, private notes on Expenses only by the Expense's host
 *   administrators. Where the GraphQL rules depend on more than administered accounts (community managers,
 *   contributors, accountants), search is stricter.
 *
 * The commented entity of each candidate is looked up by primary key (`LATERAL ... LIMIT 1`, index-only for
 * Expenses), and administered-account sets (children, hosted accounts) are hashed once. Drivers: root and host
 * administrators search the text index; administrators also search the Comments of their own Accounts (Account
 * indexes), and so do Account scopes. The host arm is skipped (one-time filter) for users who host nothing.
 *
 * OAuth tokens: Comments on Expenses need the `expenses` scope, on Orders `orders`, on non-public Updates `updates`
 * (same as `canSeeComment`), even for root.
 *
 * Arms (see `scores.ts` for bands): exact identifier (ID / `#ID`, public ID `cmt_...`, GraphQL ID) and ordinary words.
 * Comments have no title: there is no lexical bonus, ties are broken by descending ID (newest first).
 */

import { Kysely, RawBuilder, sql } from 'kysely';

import OAuthScopes from '../../../../../constants/oauth-scopes';
import { IDENTIFIER_TYPES } from '../../../../../graphql/v2/identifiers';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity } from '../../../types';
import { CommentExpressions as Exp, isOwnedByEligibleAccount, wordsTsQuery } from '../expressions';
import { isPublicIdOfEntity, parseGraphQLIdentifier } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type CommentsContext = PostgresSearchContext<SearchEntity.COMMENTS>;

const and = (conditions: RawBuilder<unknown>[]): RawBuilder<boolean> =>
  sql<boolean>`(${sql.join(conditions, sql` AND `)})`;

const or = (conditions: RawBuilder<unknown>[]): RawBuilder<boolean> =>
  sql<boolean>`(${sql.join(conditions, sql` OR `)})`;

/**
 * The commented entity, in the order used by `canSeeComment` (first non-null reference wins). Each kind is matched
 * on the Comment's own columns, then its live row is looked up (see `joinParents`).
 */
const ParentKind = {
  EXPENSE: sql`"ExpenseId" IS NOT NULL`,
  CONVERSATION: sql`"ExpenseId" IS NULL AND "ConversationId" IS NOT NULL`,
  UPDATE: sql`"ExpenseId" IS NULL AND "ConversationId" IS NULL AND "UpdateId" IS NOT NULL`,
  ORDER: sql`"ExpenseId" IS NULL AND "ConversationId" IS NULL AND "UpdateId" IS NULL AND "OrderId" IS NOT NULL`,
  HOST_APPLICATION: sql`"ExpenseId" IS NULL AND "ConversationId" IS NULL AND "UpdateId" IS NULL AND "OrderId" IS NULL AND "HostApplicationId" IS NOT NULL`,
} as const;

/** The commented Update is published and public */
const isPublicUpdate = sql`(parent_update.is_private = FALSE AND parent_update.published_at IS NOT NULL)`;

/** Accounts that are `ids` or one of their children (index `ParentCollectiveId`) */
const isAccountOrChildOf = (column: RawBuilder<unknown>, ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  sql<boolean>`(${column} = ANY(${ids}) OR ${column} IN (SELECT c.id FROM "Collectives" c WHERE c."ParentCollectiveId" = ANY(${ids})))`;

/** Accounts actively hosted by one of `ids` (index-only with `collectives_pg_search_hosted`) */
const isActivelyHostedBy = (column: RawBuilder<unknown>, ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  sql<boolean>`${column} IN (SELECT c.id FROM "Collectives" c WHERE c."HostCollectiveId" = ANY(${ids}) AND c."isActive" = TRUE AND c."deletedAt" IS NULL)`;

/**
 * The effective host of the Comment is one of `ids` (same as OpenSearch): the Expense's host (or the active host of
 * its Account when it has none), the Host Application's host, otherwise the active host of the Comment's Account.
 */
const isHostedBy = (ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  or([
    and([
      ParentKind.EXPENSE,
      or([
        sql`parent_expense.host_id = ANY(${ids})`,
        and([sql`parent_expense.host_id IS NULL`, isActivelyHostedBy(sql`"CollectiveId"`, ids)]),
      ]),
    ]),
    and([ParentKind.HOST_APPLICATION, sql`parent_application.host_id = ANY(${ids})`]),
    and([
      sql`"ExpenseId" IS NULL AND NOT (${ParentKind.HOST_APPLICATION})`,
      isActivelyHostedBy(sql`"CollectiveId"`, ids),
    ]),
  ]);

/**
 * The commented entity is live and its Account is neither deleted nor private (when it differs from the Comment's
 * Account, which is already checked). Applies to everyone, including root.
 */
const getParentEligibility = (): RawBuilder<boolean> => {
  const parentAccountIsEligible = (alias: string) =>
    or([
      sql`${sql.ref(`${alias}.collective_id`)} = "CollectiveId"`,
      isOwnedByEligibleAccount(`${alias}.collective_id`),
    ]);
  const parent = (kind: RawBuilder<unknown>, alias: string, extra: RawBuilder<unknown>[] = []) =>
    and([kind, sql`${sql.ref(`${alias}.id`)} IS NOT NULL`, parentAccountIsEligible(alias), ...extra]);

  return or([
    parent(ParentKind.EXPENSE, 'parent_expense'),
    parent(ParentKind.CONVERSATION, 'parent_conversation'),
    parent(ParentKind.UPDATE, 'parent_update'),
    // Only private notes can be posted on Orders, `canSeeComment` rejects other types
    parent(ParentKind.ORDER, 'parent_order', [sql`"type" = 'PRIVATE_NOTE'`]),
    parent(ParentKind.HOST_APPLICATION, 'parent_application'),
  ]);
};

/**
 * Row permission of OpenSearch: host administrators see every Comment, administrators of the Comment's Account, its
 * parent or its author see `COMMENT`s.
 */
const getRowPermission = (ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  or([
    isHostedBy(ids),
    and([
      sql`"type" = 'COMMENT'`,
      or([sql`"FromCollectiveId" = ANY(${ids})`, isAccountOrChildOf(sql`"CollectiveId"`, ids)]),
    ]),
  ]);

/**
 * Visibility of the commented entity for administrators of `ids`, mirroring `canSeeComment` (stricter where it
 * depends on more than administered accounts).
 */
const getParentVisibility = (ids: RawBuilder<unknown>): RawBuilder<boolean> => {
  // Expense host (`loadHostForExpense`): its own host, unless stale (Account re-hosted, Expense not paid), otherwise
  // the active host of its Account. The status is only read for stale hosts.
  const isExpenseHostAdmin = or([
    and([
      sql`parent_expense.host_id = ANY(${ids})`,
      or([
        // Per-row probe of `collectives_pg_search_hosted` (both keys bound), only for Expenses hosted by `ids`
        sql`EXISTS (SELECT 1 FROM "Collectives" c WHERE c."HostCollectiveId" = parent_expense.host_id AND c.id = parent_expense.collective_id AND c."isActive" = TRUE AND c."deletedAt" IS NULL)`,
        sql`EXISTS (SELECT 1 FROM "Expenses" paid_expense WHERE paid_expense.id = parent_expense.id AND paid_expense.status = 'PAID' OFFSET 0)`,
      ]),
    ]),
    and([sql`parent_expense.host_id IS NULL`, isActivelyHostedBy(sql`parent_expense.collective_id`, ids)]),
  ]);

  return or([
    // Expenses: host administrators; for `COMMENT`s, also administrators of the Account (or its parent) and payee
    and([
      ParentKind.EXPENSE,
      or([
        isExpenseHostAdmin,
        and([
          sql`"type" = 'COMMENT'`,
          or([
            isAccountOrChildOf(sql`parent_expense.collective_id`, ids),
            sql`parent_expense.from_collective_id = ANY(${ids})`,
          ]),
        ]),
      ]),
    ]),
    // Conversations: anyone who can see the Account
    ParentKind.CONVERSATION,
    // Updates: published public Updates; others for administrators of the Account (or its parent), and published
    // private Updates for host administrators
    and([
      ParentKind.UPDATE,
      or([
        isPublicUpdate,
        isAccountOrChildOf(sql`parent_update.collective_id`, ids),
        and([sql`parent_update.published_at IS NOT NULL`, isActivelyHostedBy(sql`parent_update.collective_id`, ids)]),
      ]),
    ]),
    // Orders: host administrators
    and([ParentKind.ORDER, isActivelyHostedBy(sql`parent_order.collective_id`, ids)]),
    // Host applications: host administrators; for `COMMENT`s, also administrators of the applying Account
    and([
      ParentKind.HOST_APPLICATION,
      or([
        sql`parent_application.host_id = ANY(${ids})`,
        and([sql`"type" = 'COMMENT'`, sql`parent_application.collective_id = ANY(${ids})`]),
      ]),
    ]),
  ]);
};

/**
 * OAuth scopes of the commented entity (same as its GraphQL rules, even for root): Expenses need `expenses`, Orders
 * need `orders`, and Updates that are not public need `updates`.
 */
const getOAuthScopeConditions = ({ access }: CommentsContext): RawBuilder<unknown>[] => {
  const denied = new Set(access.deniedOAuthScopes);
  const conditions: RawBuilder<unknown>[] = [];
  if (denied.has(OAuthScopes.expenses)) {
    conditions.push(sql`NOT (${ParentKind.EXPENSE})`);
  }
  if (denied.has(OAuthScopes.orders)) {
    conditions.push(sql`NOT (${ParentKind.ORDER})`);
  }
  if (denied.has(OAuthScopes.updates)) {
    conditions.push(sql`NOT (${ParentKind.UPDATE} AND NOT ${isPublicUpdate})`);
  }

  return conditions;
};

/**
 * Comments of `ids`' Accounts, their children, or written by `ids`. Index-driven (`comments_pg_search_collective`,
 * `comments_pg_search_from`): the Account set is computed once (InitPlan array), so the planner can scan the Comments
 * of a few Accounts instead of every text match.
 */
const isInAccountDomainOf = (ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  or([
    sql`"CollectiveId" = ANY(ARRAY(SELECT c.id FROM "Collectives" c WHERE c.id = ANY(${ids}) OR c."ParentCollectiveId" = ANY(${ids})))`,
    sql`"FromCollectiveId" = ANY(${ids})`,
  ]);

/**
 * `ids` may host Comments: one of them is a host, actively hosts an Account or received a Host Application. Uncorrelated,
 * so it becomes a one-time filter: the host arm (driven by the text index) is skipped for everyone else.
 */
const mayHostComments = (ids: RawBuilder<unknown>): RawBuilder<boolean> =>
  or([
    sql`EXISTS (SELECT 1 FROM "Collectives" c WHERE c.id = ANY(${ids}) AND (c."hasMoneyManagement" = TRUE OR c."isHostAccount" = TRUE))`,
    sql`EXISTS (SELECT 1 FROM "Collectives" c WHERE c."HostCollectiveId" = ANY(${ids}) AND c."isActive" = TRUE AND c."deletedAt" IS NULL)`,
    sql`EXISTS (SELECT 1 FROM "HostApplications" ha WHERE ha."HostCollectiveId" = ANY(${ids}))`,
  ]);

/** Account scope: the Comment's Account, its parent, or its author. Host scope: the effective host. */
const getScopeConditions = ({ scope }: CommentsContext): RawBuilder<unknown>[] => {
  const conditions: RawBuilder<unknown>[] = [];
  if (scope.accountId) {
    conditions.push(isInAccountDomainOf(sql`ARRAY[${scope.accountId}]::int[]`));
  }
  if (scope.hostId) {
    conditions.push(isHostedBy(sql`ARRAY[${scope.hostId}]::int[]`));
  }

  return conditions;
};

/** Looks up the live commented entity of each Comment by primary key (`LIMIT 1`: never flattened into a scan) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic over the arm's query builder
const joinParents = (query: any) =>
  query
    .leftJoinLateral(
      sql`(SELECT e.id, e."CollectiveId" AS collective_id, e."FromCollectiveId" AS from_collective_id, e."HostCollectiveId" AS host_id FROM "Expenses" e WHERE e.id = "Comments"."ExpenseId" AND e."deletedAt" IS NULL LIMIT 1)`.as(
        'parent_expense',
      ),
      join => join.onTrue(),
    )
    .leftJoinLateral(
      sql`(SELECT cv.id, cv."CollectiveId" AS collective_id FROM "Conversations" cv WHERE cv.id = "Comments"."ConversationId" AND cv."deletedAt" IS NULL LIMIT 1)`.as(
        'parent_conversation',
      ),
      join => join.onTrue(),
    )
    .leftJoinLateral(
      sql`(SELECT u.id, u."CollectiveId" AS collective_id, u."isPrivate" AS is_private, u."publishedAt" AS published_at FROM "Updates" u WHERE u.id = "Comments"."UpdateId" AND u."deletedAt" IS NULL LIMIT 1)`.as(
        'parent_update',
      ),
      join => join.onTrue(),
    )
    .leftJoinLateral(
      sql`(SELECT o.id, o."CollectiveId" AS collective_id FROM "Orders" o WHERE o.id = "Comments"."OrderId" AND o."deletedAt" IS NULL LIMIT 1)`.as(
        'parent_order',
      ),
      join => join.onTrue(),
    )
    .leftJoinLateral(
      sql`(SELECT ha.id, ha."CollectiveId" AS collective_id, ha."HostCollectiveId" AS host_id FROM "HostApplications" ha WHERE ha.id = "Comments"."HostApplicationId" AND ha."deletedAt" IS NULL LIMIT 1)`.as(
        'parent_application',
      ),
      join => join.onTrue(),
    );

export const CommentsAdapter: PostgresSearchAdapter<SearchEntity.COMMENTS> = {
  entity: SearchEntity.COMMENTS,
  buildArms(db: Kysely<DatabaseWithViews>, context: CommentsContext): SearchArm[] {
    const { input, access } = context;
    const conditions: RawBuilder<unknown>[] = [
      getParentEligibility(),
      ...getOAuthScopeConditions(context),
      ...getScopeConditions(context),
    ];

    // One driver per permission branch (each arm still applies the whole permission): root searches everything;
    // administrators search the Comments of their Accounts (Account index) and, when they may host Comments, the
    // Comments they host (text index).
    let drivers: RawBuilder<unknown>[];
    if (access.forbidPrivate) {
      return [];
    } else if (access.isRoot) {
      drivers = [sql`TRUE`];
    } else if (!access.adminIds.length) {
      return [];
    } else {
      const ids = sql`${access.adminIds}::int[]`;
      conditions.push(getRowPermission(ids), getParentVisibility(ids));
      drivers = [isInAccountDomainOf(ids), and([mayHostComments(ids), isHostedBy(ids)])];
    }

    const arms: SearchArm[] = [];
    const addArms = (band: QualityBand, match: RawBuilder<unknown>) => {
      for (const driver of drivers) {
        arms.push(
          joinParents(db.selectFrom('Comments'))
            .select([sql<number>`"Comments".id`.as('id'), scoreExpression(band).as('score')])
            .where(
              and([
                sql.raw(Exp.eligible),
                isOwnedByEligibleAccount('Comments.CollectiveId'),
                match,
                driver,
                ...conditions,
              ]),
            ) as SearchArm,
        );
      }
    };

    // Exact identifiers
    const ids = [input.identifiers.id, parseGraphQLIdentifier(input, IDENTIFIER_TYPES.COMMENT)].filter(Boolean);
    for (const id of new Set(ids)) {
      addArms(QualityBand.EXACT_IDENTIFIER, sql`"Comments".id = ${id}`);
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.Comment)) {
      addArms(QualityBand.EXACT_IDENTIFIER, sql`"publicId" = ${input.identifiers.publicId}`);
    }

    // Ordinary words
    addArms(QualityBand.WORDS, sql`${sql.raw(Exp.vector)} @@ ${wordsTsQuery(input.term)}`);

    return arms;
  },
};
