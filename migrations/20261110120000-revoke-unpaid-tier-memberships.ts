'use strict';

import { type QueryInterface, QueryTypes } from 'sequelize';

/**
 * Revokes tier memberships obtained by moving a recurring contribution to a tier through `updateOrder` without
 * ever paying the tier's price (e.g. create a $1/month contribution, move it to a $1,000 "Gold Sponsor" tier,
 * cancel before the next charge). `updateOrder` now defers such changes until a charge pays for the tier
 * (see `server/lib/order-tier-change.ts`); this migration brings existing data to the same state.
 *
 * An order matches only when it shows that pattern:
 * - it is recurring and on a tier with a price (fixed amount or minimum), in the order's currency
 * - its current amount meets that price (orders below the price are typically legacy contributions made before
 *   the collective raised it: they paid what was asked at the time)
 * - it was successfully charged at least once (a non-refunded CONTRIBUTION credit exists). Never-charged orders
 *   (abandoned or failed checkouts, payments in flight) gave nobody a tier and are left alone.
 * - none of its charges ever reached the tier price, refunded or not. Orders whose tier-price charges were
 *   refunded are a separate policy question and are left alone. Orders with a charge in another currency are
 *   skipped too, since the amounts can't be compared.
 * Amounts are compared with the tier price without the order's tax, like `doesAmountSatisfyTier` does.
 *
 * Nothing is done to an order that may be paying for its tier right now, so that a payment can never complete
 * against an order this migration just changed:
 * - statuses with a payment in flight (NEW, PROCESSING, REQUIRE_CLIENT_CONFIRMATION, PENDING, IN_REVIEW)
 * - orders locked by a payment webhook (`data.lockedAt`)
 * - subscriptions the hourly recurring-contributions job could charge during the migration (next charge due
 *   within the hour). They are listed in the migration log (`skippedChargeDue`) for a later check.
 * Matched rows are locked (`FOR UPDATE`) for the duration of the migration.
 *
 * For each matched order:
 * - `Orders.TierId` is set to NULL (custom contribution, which is what was paid for)
 * - unless the order can no longer be charged, the tier is stored in `data.pendingTierChange` (unless a change
 *   is already pending): it gets applied automatically once a charge pays for it. Honest contributors who
 *   upgraded and haven't been charged yet get the tier back on their next payment.
 *
 * The matching BACKER membership on the tier is moved to "no tier" (the account did pay a custom amount), or
 * soft-deleted if the account already has a no-tier membership. Memberships are kept when another contribution
 * from the same account on the same tier has been paid (e.g. a one-time contribution).
 *
 * Everything is recorded in `MigrationLogs`; `down` restores the previous values of rows that nothing else
 * changed since.
 */

const MIGRATION_NAME = '20261110120000-revoke-unpaid-tier-memberships';

/** A payment may be completing for these: never touched. */
const IN_FLIGHT_STATUSES = ['NEW', 'PROCESSING', 'REQUIRE_CLIENT_CONFIRMATION', 'PENDING', 'IN_REVIEW'];

/** Can't be charged anymore: no pending tier change is stored for these. */
const FINAL_STATUSES = ['CANCELLED', 'EXPIRED', 'REJECTED', 'REFUNDED', 'DISPUTED', 'PAID'];

type MatchedOrder = {
  id: number;
  TierId: number;
  FromCollectiveId: number;
  CollectiveId: number;
  status: string;
  pendingTierChange: Record<string, unknown> | null;
  isChargeDue?: boolean;
};

type UpdatedOrder = MatchedOrder & {
  /** `data.pendingTierChange` as left by the migration, so `down` can tell whether something changed it since */
  pendingTierChangeAfter: Record<string, unknown> | null;
};

type MatchedMember = {
  id: number;
  TierId: number;
  MemberCollectiveId: number;
  CollectiveId: number;
};

type MigrationData = {
  orders: UpdatedOrder[];
  membersMovedToNoTier: MatchedMember[];
  membersDeleted: MatchedMember[];
  /** Identical `deletedAt` set on `membersDeleted` */
  deletedAt: string;
  /** Matched, but left alone because the recurring-contributions job could charge them during the migration */
  skippedChargeDue: number[];
};

const CONTRIBUTION_CREDIT = `
  tr."OrderId" = o.id
  AND tr.kind = 'CONTRIBUTION'
  AND tr.type = 'CREDIT'
  AND tr."isRefund" IS FALSE
  AND tr."deletedAt" IS NULL
`;

const REQUIRED_AMOUNT = `
  COALESCE(CASE WHEN t."amountType" = 'FIXED' THEN t.amount END, t."minimumAmount") * COALESCE(o.quantity, 1)
`;

/** Copy of `ZERO_DECIMAL_CURRENCIES` (server/constants/currencies.ts): their amounts are rounded to the unit (x100) */
const ZERO_DECIMAL_CURRENCIES = [
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
];

const TAX_PERCENTAGE = `
  CASE
    WHEN JSONB_TYPEOF(o.data #> '{tax,percentage}') = 'number'
    THEN GREATEST(CAST(o.data #>> '{tax,percentage}' AS NUMERIC), 0)
    ELSE 0
  END
`;

/**
 * A tax-inclusive amount of the order without its tax, as `doesAmountSatisfyTier` computes it:
 * `roundCentsAmount(amount / (1 + taxPercentage / 100), currency)`. Tier prices don't include taxes.
 */
const withoutTax = (amount: string) => `
  ROUND(
    (${amount}) / (1 + (${TAX_PERCENTAGE}) / 100),
    CASE WHEN o.currency IN (:zeroDecimalCurrencies) THEN -2 ELSE 0 END
  )
`;

const MATCHED_ORDERS_QUERY = `
  SELECT
    o.id,
    o."TierId",
    o."FromCollectiveId",
    o."CollectiveId",
    o.status,
    o.data -> 'pendingTierChange' AS "pendingTierChange",
    -- What the hourly recurring-contributions job could pick up during the migration (see ordersWithPendingCharges)
    COALESCE(
      o.status NOT IN ('PAUSED', 'PROCESSING', 'CANCELLED')
      AND s."isActive"
      AND s."deactivatedAt" IS NULL
      AND s."deletedAt" IS NULL
      AND s."isManagedExternally" IS FALSE
      AND s."nextChargeDate" <= NOW() + INTERVAL '1 hour',
      FALSE
    ) AS "isChargeDue"
  FROM "Orders" o
  INNER JOIN "Tiers" t ON t.id = o."TierId"
  LEFT JOIN "Subscriptions" s ON s.id = o."SubscriptionId"
  WHERE o."deletedAt" IS NULL
  AND o.interval IS NOT NULL
  AND o.currency = t.currency
  AND o.status NOT IN (:inFlightStatuses)
  AND o.data ->> 'lockedAt' IS NULL
  AND ${REQUIRED_AMOUNT} > 0
  AND ${withoutTax(`o."totalAmount" - COALESCE(o."platformTipAmount", 0)`)} >= ${REQUIRED_AMOUNT}
  -- Successfully charged at least once
  AND EXISTS (SELECT 1 FROM "Transactions" tr WHERE ${CONTRIBUTION_CREDIT} AND tr."RefundTransactionId" IS NULL)
  -- ...but never at the tier price, refunded or not (and never in another currency)
  AND NOT EXISTS (
    SELECT 1
    FROM "Transactions" tr
    WHERE ${CONTRIBUTION_CREDIT}
    AND (tr.currency <> o.currency OR ${withoutTax('tr.amount')} >= ${REQUIRED_AMOUNT})
  )
  ORDER BY o.id
  FOR UPDATE OF o
`;

// BACKER memberships of the matched orders, unless another contribution from the account on the same tier was paid
const MATCHED_MEMBERS_QUERY = `
  SELECT m.id, m."TierId", m."MemberCollectiveId", m."CollectiveId"
  FROM "Members" m
  WHERE m.role = 'BACKER'
  AND m."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "Orders" o
    WHERE o.id IN (:orderIds)
    AND o."FromCollectiveId" = m."MemberCollectiveId"
    AND o."CollectiveId" = m."CollectiveId"
    AND o."TierId" = m."TierId"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "Orders" other
    INNER JOIN "Transactions" tr
      ON tr."OrderId" = other.id
      AND tr.kind = 'CONTRIBUTION'
      AND tr.type = 'CREDIT'
      AND tr."isRefund" IS FALSE
      AND tr."RefundTransactionId" IS NULL
      AND tr."deletedAt" IS NULL
    WHERE other."FromCollectiveId" = m."MemberCollectiveId"
    AND other."CollectiveId" = m."CollectiveId"
    AND other."TierId" = m."TierId"
    AND other."deletedAt" IS NULL
    AND other.id NOT IN (:orderIds)
  )
  ORDER BY m.id
  FOR UPDATE OF m
`;

module.exports = {
  async up(queryInterface: QueryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async transaction => {
      const matched = await sequelize.query<MatchedOrder>(MATCHED_ORDERS_QUERY, {
        type: QueryTypes.SELECT,
        replacements: { inFlightStatuses: IN_FLIGHT_STATUSES, zeroDecimalCurrencies: ZERO_DECIMAL_CURRENCIES },
        transaction,
      });

      const skippedChargeDue = matched.filter(o => o.isChargeDue).map(o => o.id);
      const orders = matched.filter(o => !o.isChargeDue).map(({ isChargeDue, ...order }) => order); // eslint-disable-line @typescript-eslint/no-unused-vars
      if (!matched.length) {
        return;
      }

      // When every matched order is skipped, nothing is updated but the skipped ones are still logged
      const orderIds = orders.map(o => o.id);
      const members = !orders.length
        ? []
        : await sequelize.query<MatchedMember>(MATCHED_MEMBERS_QUERY, {
            type: QueryTypes.SELECT,
            replacements: { orderIds },
            transaction,
          });

      // Members: move to "no tier", unless the account already has a "no tier" membership for this collective
      // (or another revoked membership was already moved there)
      const membersMovedToNoTier: MatchedMember[] = [];
      const membersDeleted: MatchedMember[] = [];
      const pairsWithNoTierMembership = new Set<string>();
      if (members.length) {
        const existingNoTierMembers = await sequelize.query<{ MemberCollectiveId: number; CollectiveId: number }>(
          `
          SELECT DISTINCT "MemberCollectiveId", "CollectiveId"
          FROM "Members"
          WHERE role = 'BACKER'
          AND "TierId" IS NULL
          AND "deletedAt" IS NULL
          AND "MemberCollectiveId" IN (:memberCollectiveIds)
        `,
          {
            type: QueryTypes.SELECT,
            replacements: { memberCollectiveIds: [...new Set(members.map(m => m.MemberCollectiveId))] },
            transaction,
          },
        );
        existingNoTierMembers.forEach(m => pairsWithNoTierMembership.add(`${m.MemberCollectiveId}-${m.CollectiveId}`));
      }

      for (const member of members) {
        const pairKey = `${member.MemberCollectiveId}-${member.CollectiveId}`;
        if (pairsWithNoTierMembership.has(pairKey)) {
          membersDeleted.push(member);
        } else {
          membersMovedToNoTier.push(member);
          pairsWithNoTierMembership.add(pairKey);
        }
      }

      if (membersMovedToNoTier.length) {
        await sequelize.query(`UPDATE "Members" SET "TierId" = NULL, "updatedAt" = NOW() WHERE id IN (:ids)`, {
          replacements: { ids: membersMovedToNoTier.map(m => m.id) },
          transaction,
        });
      }

      const deletedAt = new Date().toISOString();
      if (membersDeleted.length) {
        await sequelize.query(`UPDATE "Members" SET "deletedAt" = :deletedAt WHERE id IN (:ids)`, {
          replacements: { ids: membersDeleted.map(m => m.id), deletedAt },
          transaction,
        });
      }

      // Orders: back to custom contribution, with the tier pending for the ones that can still be charged
      type UpdatedRow = { id: number; pendingTierChangeAfter: Record<string, unknown> | null };
      const updated = !orders.length
        ? []
        : await sequelize.query<UpdatedRow>(
            `
        UPDATE "Orders"
        SET
          "TierId" = NULL,
          "updatedAt" = NOW(),
          "data" = CASE
            WHEN status NOT IN (:finalStatuses) THEN JSONB_SET(
              COALESCE("data", '{}'::jsonb),
              '{pendingTierChange}',
              COALESCE(
                "data" -> 'pendingTierChange',
                JSONB_BUILD_OBJECT(
                  'TierId', "TierId",
                  'previousTierId', NULL,
                  'requestedAt', CAST(:requestedAt AS TEXT),
                  'requestedByUserId', NULL,
                  'source', CAST(:source AS TEXT)
                )
              )
            )
            ELSE "data"
          END
        WHERE id IN (:orderIds)
        RETURNING id, "data" -> 'pendingTierChange' AS "pendingTierChangeAfter"
      `,
            {
              type: QueryTypes.SELECT,
              replacements: {
                orderIds,
                finalStatuses: FINAL_STATUSES,
                requestedAt: new Date().toISOString(),
                source: MIGRATION_NAME,
              },
              transaction,
            },
          );

      const pendingAfterById = new Map(updated.map(o => [o.id, o.pendingTierChangeAfter ?? null]));
      const data: MigrationData = {
        orders: orders.map(o => ({ ...o, pendingTierChangeAfter: pendingAfterById.get(o.id) ?? null })),
        membersMovedToNoTier,
        membersDeleted,
        deletedAt,
        skippedChargeDue,
      };
      await sequelize.query(
        `
        INSERT INTO "MigrationLogs" ("type", "createdAt", "description", "data")
        VALUES ('MIGRATION', NOW(), :description, :data)
      `,
        {
          replacements: { description: MIGRATION_NAME, data: JSON.stringify(data) },
          transaction,
        },
      );
    });
  },

  /**
   * Restores what `up` changed, row by row, skipping rows changed since (e.g. a pending tier applied after a
   * payment, a new membership on the same tier). Skipped rows are reported.
   */
  async down(queryInterface: QueryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async transaction => {
      const [migrationLog] = await sequelize.query<{ id: number; data: MigrationData }>(
        `SELECT id, data FROM "MigrationLogs" WHERE type = 'MIGRATION' AND description = :description ORDER BY id DESC LIMIT 1`,
        { type: QueryTypes.SELECT, replacements: { description: MIGRATION_NAME }, transaction },
      );

      if (!migrationLog) {
        return;
      }

      const { orders, membersMovedToNoTier, membersDeleted, deletedAt } = migrationLog.data;
      const skipped = { orders: [] as number[], members: [] as number[] };

      for (const order of orders) {
        const [restored] = await sequelize.query<{ id: number }>(
          `
          UPDATE "Orders"
          SET
            "TierId" = :TierId,
            "updatedAt" = NOW(),
            "data" = CASE
              WHEN CAST(:pendingTierChange AS JSONB) IS NULL THEN "data" - 'pendingTierChange'
              ELSE JSONB_SET(COALESCE("data", '{}'::jsonb), '{pendingTierChange}', CAST(:pendingTierChange AS JSONB))
            END
          WHERE id = :id
          AND "TierId" IS NULL
          AND "data" -> 'pendingTierChange' IS NOT DISTINCT FROM CAST(:pendingTierChangeAfter AS JSONB)
          RETURNING id
        `,
          {
            type: QueryTypes.SELECT,
            replacements: {
              id: order.id,
              TierId: order.TierId,
              pendingTierChange: order.pendingTierChange ? JSON.stringify(order.pendingTierChange) : null,
              pendingTierChangeAfter: order.pendingTierChangeAfter
                ? JSON.stringify(order.pendingTierChangeAfter)
                : null,
            },
            transaction,
          },
        );
        if (!restored) {
          skipped.orders.push(order.id);
        }
      }

      // A membership is only restored if no active membership already holds the same tier
      const noActiveTwin = `
        NOT EXISTS (
          SELECT 1 FROM "Members" twin
          WHERE twin.id <> m.id
          AND twin."MemberCollectiveId" = m."MemberCollectiveId"
          AND twin."CollectiveId" = m."CollectiveId"
          AND twin.role = m.role
          AND twin."TierId" = :TierId
          AND twin."deletedAt" IS NULL
        )
      `;

      for (const member of membersMovedToNoTier) {
        const [restored] = await sequelize.query<{ id: number }>(
          `
          UPDATE "Members" m SET "TierId" = :TierId, "updatedAt" = NOW()
          WHERE m.id = :id AND m."TierId" IS NULL AND m."deletedAt" IS NULL AND ${noActiveTwin}
          RETURNING m.id
        `,
          { type: QueryTypes.SELECT, replacements: { id: member.id, TierId: member.TierId }, transaction },
        );
        if (!restored) {
          skipped.members.push(member.id);
        }
      }

      for (const member of membersDeleted) {
        const [restored] = await sequelize.query<{ id: number }>(
          `
          UPDATE "Members" m SET "deletedAt" = NULL
          WHERE m.id = :id AND m."deletedAt" = :deletedAt AND ${noActiveTwin}
          RETURNING m.id
        `,
          { type: QueryTypes.SELECT, replacements: { id: member.id, TierId: member.TierId, deletedAt }, transaction },
        );
        if (!restored) {
          skipped.members.push(member.id);
        }
      }

      if (skipped.orders.length || skipped.members.length) {
        console.log(
          `${MIGRATION_NAME}: left alone because they changed since the migration: ` +
            `orders ${JSON.stringify(skipped.orders)}, members ${JSON.stringify(skipped.members)}`,
        );
      }

      await sequelize.query(`DELETE FROM "MigrationLogs" WHERE id = :id`, {
        replacements: { id: migrationLog.id },
        transaction,
      });
    });
  },
};
