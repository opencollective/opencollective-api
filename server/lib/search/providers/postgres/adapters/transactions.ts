/**
 * Transactions adapter for PostgreSQL search.
 *
 * Coverage (same fields as OpenSearch, on live rows and relationships): ID / `#ID`, public ID (`tx_...`), UUID (also
 * the GraphQL ID), transaction group, description, kind and type, and the virtual merchant ID for administrators of
 * the transaction's host (or root).
 *
 * The merchant ID is not a column: it reproduces the model getter and the GraphQL resolver, kind by kind
 * (`MERCHANT_ID_PATHS` in `server/models/Transaction.ts`, `merchantId` in `server/graphql/v2/interface/Transaction.js`):
 * - CONTRIBUTION and EXPENSE: the first non-empty provider ID of the row's own JSON
 * - EXPENSE without one: the Expense's `data.transactionId`
 * - PLATFORM_TIP and APPLICATION_FEE: the merchant ID of the related CONTRIBUTION (same group and type), except on
 *   platform rows of revenue collected directly by the platform, where the resolver shows the Stripe application fee
 *   instead (platform-only reconciliation, not searchable)
 * All of them are exact, index-backed lookups on live rows: source edits apply immediately. Like OpenSearch, only
 * administrators of the host (not accountants) can search them. The platform-only application fee IDs (platform tips,
 * application fees and host fee shares) are not searchable.
 *
 * Arms (see `scores.ts` for bands):
 * - exact identifier: IDs above and merchant IDs
 * - all the words of the description (exact descriptions are ranked as exact labels), and kind/type when the whole
 *   input is one of their values
 *
 * Rules shared by every arm:
 * - eligibility (OpenSearch indexing rules): the transaction is not deleted, its account and counterparty are neither
 *   deleted nor private, and its host, if any, is neither deleted nor private. Applies to root too.
 * - host scope: the transaction's own `HostCollectiveId`
 * - account scope: the ledger of the account and of its children (`CollectiveId`). With double-entry accounting,
 *   every transaction of an account has a row on its ledger.
 *
 * Broad words match millions of transactions ("contribution", "fee"): searches estimated to match more than can be
 * counted within the budget fail before running (`estimatedMatchesPerSecond`). Scopes are index-backed (host or
 * account with description words), so scoped searches stay fast.
 *
 * Queries select from "Transactions" only (other tables in subqueries) so that unqualified column names keep
 * matching the index expressions.
 */

import { Kysely, RawBuilder, sql } from 'kysely';

import PlatformConstants from '../../../../../constants/platform';
import { TransactionKind } from '../../../../../constants/transaction-kind';
import { TransactionTypes } from '../../../../../constants/transactions';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity, SearchHit } from '../../../types';
import {
  isEligibleAccountId,
  isOwnedByEligibleAccount,
  normalizedValue,
  TransactionExpressions as Exp,
  wordsTsQuery,
} from '../expressions';
import { isPublicIdOfEntity } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type TransactionsContext = PostgresSearchContext<SearchEntity.TRANSACTIONS>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Provider IDs: Stripe `ch_...`, PayPal `5TY05013RG002845M`, Wise `123456789`, Privacy tokens... */
const MERCHANT_ID_PATTERN = /^[A-Za-z0-9_.:-]{3,255}$/;

const and = (conditions: RawBuilder<unknown>[]): RawBuilder<boolean> =>
  sql<boolean>`${sql.join(conditions, sql` AND `)}`;

/**
 * Eligibility and scopes, as alternatives: each one becomes its own arm (a transaction can match several, the query
 * builder keeps one). Supplied account and host scopes intersect.
 *
 * When a scope fixes an account column, its eligibility is checked once (`isEligibleAccountId`): the planner's
 * estimates must stay realistic for `estimatedMatchesPerSecond`.
 */
const getScopeVariants = ({ scope }: TransactionsContext): RawBuilder<unknown>[][] => {
  const base = [
    sql.raw(Exp.eligible),
    isOwnedByEligibleAccount('Transactions.FromCollectiveId'),
    ...(scope.hostId
      ? [sql`"HostCollectiveId" = ${scope.hostId}`, isEligibleAccountId(scope.hostId)]
      : [isOwnedByEligibleAccount('Transactions.HostCollectiveId')]),
  ];
  if (!scope.accountId) {
    return [[...base, isOwnedByEligibleAccount('Transactions.CollectiveId')]];
  }

  return [
    [...base, sql`"CollectiveId" = ${scope.accountId}`, isEligibleAccountId(scope.accountId)],
    [
      ...base,
      sql`"CollectiveId" IN (SELECT c.id FROM "Collectives" c WHERE c."ParentCollectiveId" = ${scope.accountId} AND c."deletedAt" IS NULL)`,
      isOwnedByEligibleAccount('Transactions.CollectiveId'),
    ],
  ];
};

/**
 * Merchant IDs are only searchable by root and by administrators of the transaction's host. Returns `null` when the
 * user can't search them.
 */
const getMerchantIdPermission = ({ access }: TransactionsContext): RawBuilder<unknown> | null => {
  if (access.forbidPrivate) {
    return null;
  } else if (access.isRoot) {
    return sql`TRUE`;
  } else if (!access.adminIds.length) {
    return null;
  } else {
    return sql`"HostCollectiveId" = ANY(${access.adminIds}::int[])`;
  }
};

/** The whole input as a kind (`host fee`, `HOST_FEE`...), if it is one */
const parseKind = (term: string): TransactionKind | null => {
  const value = term
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return Object.values(TransactionKind).includes(value as TransactionKind) ? (value as TransactionKind) : null;
};

const parseType = (term: string): TransactionTypes | null => {
  const value = term.trim().toUpperCase();
  return Object.values(TransactionTypes).includes(value as TransactionTypes) ? (value as TransactionTypes) : null;
};

const getMerchantIdConditions = (merchantId: string): RawBuilder<unknown>[][] => {
  // Groups and types of the live CONTRIBUTION rows that have this merchant ID (driven by the merchant ID index)
  const contributions = (where: RawBuilder<unknown> = sql`TRUE`) =>
    sql`("TransactionGroup", type) IN (
      SELECT contribution."TransactionGroup", contribution.type FROM "Transactions" contribution
      WHERE public.oc_search_transaction_merchant_id(contribution.kind, contribution.data) = ${merchantId}
      AND contribution.kind = 'CONTRIBUTION' AND contribution."deletedAt" IS NULL AND ${where}
    )`;
  const platformTipKinds = sql`kind IN ('PLATFORM_TIP', 'APPLICATION_FEE')`;
  return [
    // From the row's own JSON (CONTRIBUTION, EXPENSE)
    [sql`${sql.raw(Exp.merchantId)} = ${merchantId}`],
    // EXPENSE rows without one: the Expense's (index `expenses_data_stripe_virtual_card_transaction_id`). The matching
    // Expenses are looked up first (InitPlan array): as a semi-join, the planner scanned the transactions of every
    // Expense of an account scope instead (60 ms -> 5 ms on 13M transactions).
    [
      sql`kind = 'EXPENSE'`,
      sql`"ExpenseId" = ANY(ARRAY(SELECT e.id FROM "Expenses" e WHERE e.data #>> '{transactionId}' = ${merchantId} AND e."deletedAt" IS NULL))`,
      sql`${sql.raw(Exp.merchantId)} IS NULL`,
    ],
    // PLATFORM_TIP and APPLICATION_FEE: the related CONTRIBUTION's (same group and type), except on platform rows
    // when the platform collected the revenue directly (the resolver shows the application fee there)
    [
      platformTipKinds,
      contributions(sql`(contribution.data ->> 'isPlatformRevenueDirectlyCollected')::boolean IS NOT TRUE`),
    ],
    [
      platformTipKinds,
      sql`("HostCollectiveId" <> ${PlatformConstants.PlatformCollectiveId} OR "HostCollectiveId" IS NULL)`,
      contributions(),
    ],
  ];
};

export const TransactionsAdapter: PostgresSearchAdapter<SearchEntity.TRANSACTIONS> = {
  entity: SearchEntity.TRANSACTIONS,
  // Measured on 13M synthetic transactions (docs/postgres-search.md): 270k-570k matches/s with a warm cache, 40k-300k/s
  // cold (scattered matches of a host scope are the slowest). 50k/s keeps every search that can complete cold within
  // the budget (e.g. 250k matches in 10 s), and rejects in milliseconds the unscoped broad terms ("contribution", "fee",
  // "credit") that match millions of rows instead of holding a connection until `statement_timeout`.
  estimatedMatchesPerSecond: 50_000,
  buildArms(db: Kysely<DatabaseWithViews>, context: TransactionsContext): SearchArm[] {
    const { input } = context;
    const scopeVariants = getScopeVariants(context);
    const arms: SearchArm[] = [];
    const addArms = (score: RawBuilder<number>, conditions: RawBuilder<unknown>[]) => {
      for (const scopeConditions of scopeVariants) {
        arms.push(
          db
            .selectFrom('Transactions')
            .select([sql<number>`id`.as('id'), score.as('score')])
            .where(and([...scopeConditions, ...conditions])) as SearchArm,
        );
      }
    };

    // Exact identifiers
    const exactIdentifier = scoreExpression(QualityBand.EXACT_IDENTIFIER);
    if (input.identifiers.id) {
      addArms(exactIdentifier, [sql`id = ${input.identifiers.id}`]);
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.Transaction)) {
      addArms(exactIdentifier, [sql`"publicId" = ${input.identifiers.publicId}`]);
    }
    if (UUID_PATTERN.test(input.term)) {
      const uuid = input.term.toLowerCase();
      addArms(exactIdentifier, [sql`uuid = ${uuid}::uuid`]);
      addArms(exactIdentifier, [sql`"TransactionGroup" = ${uuid}::uuid`]);
    }

    // Merchant IDs (restricted)
    const merchantIdPermission = getMerchantIdPermission(context);
    if (merchantIdPermission && MERCHANT_ID_PATTERN.test(input.term)) {
      for (const conditions of getMerchantIdConditions(input.term)) {
        addArms(exactIdentifier, [...conditions, merchantIdPermission]);
      }
    }

    // All the words of the description. Exact descriptions are ranked as exact labels: they always contain all their
    // words, so they don't need their own index.
    addArms(
      sql<number>`CASE WHEN ${sql.raw(Exp.normalizedDescription)} = ${normalizedValue(input.term)} THEN ${scoreExpression(QualityBand.EXACT_LABEL)} ELSE ${scoreExpression(QualityBand.WORDS)} END`,
      [sql`${sql.raw(Exp.descriptionVector)} @@ ${wordsTsQuery(input.term)}`],
    );

    // Kind and type, when the whole input is one of their values
    const kind = parseKind(input.term);
    if (kind) {
      addArms(scoreExpression(QualityBand.WORDS), [sql`kind = ${kind}`]);
    }
    const type = parseType(input.term);
    if (type) {
      addArms(scoreExpression(QualityBand.WORDS), [sql`type = ${type}`]);
    }

    return arms;
  },
  /** Transactions are identified by UUID in GraphQL */
  async decorateHits(db: Kysely<DatabaseWithViews>, hits: SearchHit[]): Promise<SearchHit[]> {
    if (!hits.length) {
      return hits;
    }

    const rows = await db
      .selectFrom('Transactions')
      .select(['id', 'uuid'])
      .where(
        'id',
        'in',
        hits.map(hit => hit.id),
      )
      .execute();
    const uuids = new Map(rows.map(row => [row.id, row.uuid]));
    return hits.map(hit => ({ ...hit, uuid: uuids.get(hit.id) }));
  },
};
