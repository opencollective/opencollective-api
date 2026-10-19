/**
 * Orders (Contributions) adapter for PostgreSQL search.
 *
 * Coverage (same as OpenSearch, on live rows and relationships): ID / `#ID`, public ID (`or_...`), GraphQL ID,
 * description, and the PayPal subscription ID of the Order's Subscription for administrators of the contribution's
 * host (or root).
 *
 * Arms (see `scores.ts` for bands):
 * - exact identifier: IDs above, and the PayPal subscription ID (exact, through the unique Subscriptions index)
 * - exact label: normalized description equality
 * - ordinary words: all the words of the description (stemming, accents/case folded)
 *
 * Rules shared by every arm:
 * - eligibility: the Order is not deleted, and the receiving account (`CollectiveId`) is neither deleted nor
 *   private, even for root
 * - host attribution: the receiving account's host, when the account is active
 * - account scope: contributions to the account or its children, and contributions made by the account. Each of
 *   these is its own arm, so that a selective scope drives its own index instead of filtering every text match.
 *
 * Queries select from "Orders" only: "Collectives" and "Subscriptions" are reached through subqueries (aliased
 * `c`), so that unqualified column names keep matching the index expressions.
 */

import { Kysely, RawBuilder, sql } from 'kysely';

import { IDENTIFIER_TYPES } from '../../../../../graphql/v2/identifiers';
import type { DatabaseWithViews } from '../../../../kysely';
import { EntityShortIdPrefix } from '../../../../permalink/entity-map';
import { SearchEntity } from '../../../types';
import { isOwnedByEligibleAccount, normalizedValue, OrderExpressions as Exp, wordsTsQuery } from '../expressions';
import { isPublicIdOfEntity, parseGraphQLIdentifier } from '../input';
import { QualityBand, scoreExpression } from '../scores';

import { resolveRestrictedAccess } from './access';
import type { PostgresSearchAdapter, PostgresSearchContext, SearchArm } from './types';

type OrdersContext = PostgresSearchContext<SearchEntity.ORDERS>;

/** PayPal subscription IDs look like `I-BW452GLLEP1G` */
const PAYPAL_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9-]{3,255}$/;

const and = (conditions: RawBuilder<unknown>[]): RawBuilder<boolean> =>
  sql<boolean>`${sql.join(conditions, sql` AND `)}`;

/** The receiving account is actively hosted by one of these hosts (index `collectives_pg_search_hosted`) */
const receivedByHostedAccount = (hostIds: RawBuilder<unknown>): RawBuilder<unknown> =>
  sql`"CollectiveId" IN (SELECT c.id FROM "Collectives" c WHERE c."HostCollectiveId" = ${hostIds} AND c."isActive" = TRUE AND c."deletedAt" IS NULL)`;

/**
 * Eligibility and scopes, as alternatives: each one becomes its own arm (a contribution can match several, the
 * query builder keeps one). Supplied account and host scopes intersect.
 */
const getScopeVariants = ({ scope }: OrdersContext): RawBuilder<unknown>[][] => {
  const common = [sql.raw(Exp.eligible), isOwnedByEligibleAccount('Orders.CollectiveId')];
  if (scope.hostId) {
    common.push(receivedByHostedAccount(sql`${scope.hostId}`));
  }
  if (!scope.accountId) {
    return [common];
  }

  const accountId = scope.accountId;
  return [
    [...common, sql`"CollectiveId" = ${accountId}`],
    [...common, sql`"CollectiveId" IN (SELECT c.id FROM "Collectives" c WHERE c."ParentCollectiveId" = ${accountId})`],
    [...common, sql`"FromCollectiveId" = ${accountId}`],
  ];
};

/**
 * Restricted fields (PayPal subscription ID) are only searchable by root and by administrators of the
 * contribution's host. Returns `null` when the user can't search them.
 */
const getRestrictedFieldsPermission = ({ access }: OrdersContext): RawBuilder<unknown> | null =>
  resolveRestrictedAccess<RawBuilder<unknown>>(access, {
    forRoot: sql`TRUE`,
    forAdmins: ids => receivedByHostedAccount(sql`ANY(${ids})`),
  });

export const OrdersAdapter: PostgresSearchAdapter<SearchEntity.ORDERS> = {
  entity: SearchEntity.ORDERS,
  buildArms(db: Kysely<DatabaseWithViews>, context: OrdersContext): SearchArm[] {
    const { input } = context;
    const scopeVariants = getScopeVariants(context);
    const arms: SearchArm[] = [];
    const addArms = (band: QualityBand, conditions: RawBuilder<unknown>[]) => {
      for (const scopeConditions of scopeVariants) {
        arms.push(
          db
            .selectFrom('Orders')
            .select([sql<number>`id`.as('id'), scoreExpression(band).as('score')])
            .where(and([...scopeConditions, ...conditions])) as SearchArm,
        );
      }
    };

    // Exact identifiers
    const ids = [input.identifiers.id, parseGraphQLIdentifier(input, IDENTIFIER_TYPES.ORDER)].filter(Boolean);
    for (const id of new Set(ids)) {
      addArms(QualityBand.EXACT_IDENTIFIER, [sql`id = ${id}`]);
    }
    if (isPublicIdOfEntity(input, EntityShortIdPrefix.Order)) {
      addArms(QualityBand.EXACT_IDENTIFIER, [sql`"publicId" = ${input.identifiers.publicId}`]);
    }

    // PayPal subscription ID: exact (as typed, or uppercased like PayPal IDs), through the live Subscription
    const restrictedPermission = getRestrictedFieldsPermission(context);
    if (restrictedPermission && PAYPAL_SUBSCRIPTION_ID_PATTERN.test(input.term)) {
      const paypalIds = [...new Set([input.term, input.term.toUpperCase()])];
      addArms(QualityBand.EXACT_IDENTIFIER, [
        sql`"SubscriptionId" IS NOT NULL`,
        sql`"SubscriptionId" IN (SELECT id FROM "Subscriptions" WHERE "paypalSubscriptionId" IN (${sql.join(paypalIds)}) AND "deletedAt" IS NULL)`,
        restrictedPermission,
      ]);
    }

    // Exact description, then all the words of the description
    addArms(QualityBand.EXACT_LABEL, [sql`${sql.raw(Exp.normalizedDescription)} = ${normalizedValue(input.term)}`]);
    addArms(QualityBand.WORDS, [sql`${sql.raw(Exp.descriptionVector)} @@ ${wordsTsQuery(input.term)}`]);

    return arms;
  },
};
