'use strict';

import { type QueryInterface, QueryTypes } from 'sequelize';

/**
 * Revokes tier memberships obtained by moving a recurring contribution to a tier through `updateOrder` without
 * ever paying the tier's price (e.g. create a $1/month contribution, move it to a $1,000 "Gold Sponsor" tier,
 * cancel before the next charge). `updateOrder` now defers such changes until a charge pays for the tier
 * (see `server/lib/order-tier-change.ts`); this migration brings existing data to the same state.
 *
 * An order matches when:
 * - it is recurring and on a tier with a price (fixed amount or minimum)
 * - its current amount meets that price (orders whose amount is below the price are typically legacy contributions
 *   made before the collective raised the price: they paid what was asked at the time, so we leave them alone)
 * - none of its non-refunded contribution charges ever reached that price. Orders with a charge in another
 *   currency are skipped, since we can't compare amounts.
 *
 * For each matched order:
 * - `Orders.TierId` is set to NULL (custom contribution, which is what was paid for)
 * - if the subscription can still be charged, the tier is stored in `data.pendingTierChange` (unless a change is
 *   already pending): it gets applied
 *   automatically once a charge pays for it. This covers honest contributors who upgraded and haven't been
 *   charged yet: they get the tier back on their next payment, like any upgrade made from now on.
 *
 * The matching BACKER membership on the tier is moved to "no tier" (the account did pay a custom amount), or
 * soft-deleted if the account already has a no-tier membership. Memberships are kept when another contribution
 * from the same account on the same tier has been paid (e.g. a one-time contribution).
 *
 * Everything is recorded in `MigrationLogs`; `down` restores the previous values.
 */

const MIGRATION_NAME = '20261110120000-revoke-unpaid-tier-memberships';

// Statuses for which the subscription may still be charged
const CHARGEABLE_STATUSES = ['ACTIVE', 'PAUSED', 'ERROR', 'PROCESSING', 'REQUIRE_CLIENT_CONFIRMATION'];

type MatchedOrder = {
  id: number;
  TierId: number;
  FromCollectiveId: number;
  CollectiveId: number;
  status: string;
  pendingTierChange: Record<string, unknown> | null;
};

type MatchedMember = {
  id: number;
  TierId: number;
  MemberCollectiveId: number;
  CollectiveId: number;
};

type MigrationData = {
  orders: MatchedOrder[];
  membersMovedToNoTier: MatchedMember[];
  membersDeleted: MatchedMember[];
};

const MATCHED_ORDERS_QUERY = `
  WITH tier_orders AS (
    SELECT
      o.id,
      o."TierId",
      o."FromCollectiveId",
      o."CollectiveId",
      o.status,
      o.currency,
      o."totalAmount" - COALESCE(o."platformTipAmount", 0) AS "amountWithoutTip",
      o.data -> 'pendingTierChange' AS "pendingTierChange",
      COALESCE(CASE WHEN t."amountType" = 'FIXED' THEN t.amount END, t."minimumAmount") * COALESCE(o.quantity, 1)
        AS "requiredAmount"
    FROM "Orders" o
    INNER JOIN "Tiers" t ON t.id = o."TierId"
    WHERE o."deletedAt" IS NULL
    AND o.interval IS NOT NULL
    AND o.currency = t.currency
  )
  SELECT id, "TierId", "FromCollectiveId", "CollectiveId", status, "pendingTierChange"
  FROM tier_orders o
  WHERE o."requiredAmount" > 0
  AND o."amountWithoutTip" >= o."requiredAmount"
  AND NOT EXISTS (
    SELECT 1
    FROM "Transactions" tr
    WHERE tr."OrderId" = o.id
    AND tr.kind = 'CONTRIBUTION'
    AND tr.type = 'CREDIT'
    AND tr."isRefund" IS FALSE
    AND tr."RefundTransactionId" IS NULL
    AND tr."deletedAt" IS NULL
    AND (tr.currency <> o.currency OR tr.amount >= o."requiredAmount")
  )
  ORDER BY o.id
`;

// BACKER memberships of the matched orders, unless another contribution from the account on the same tier was paid
const MATCHED_MEMBERS_QUERY = `
  SELECT DISTINCT m.id, m."TierId", m."MemberCollectiveId", m."CollectiveId"
  FROM "Members" m
  INNER JOIN "Orders" o
    ON o."FromCollectiveId" = m."MemberCollectiveId"
    AND o."CollectiveId" = m."CollectiveId"
    AND o."TierId" = m."TierId"
  WHERE o.id IN (:orderIds)
  AND m.role = 'BACKER'
  AND m."deletedAt" IS NULL
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
`;

module.exports = {
  async up(queryInterface: QueryInterface) {
    const { sequelize } = queryInterface;
    await sequelize.transaction(async transaction => {
      const orders = await sequelize.query<MatchedOrder>(MATCHED_ORDERS_QUERY, {
        type: QueryTypes.SELECT,
        transaction,
      });

      if (!orders.length) {
        return;
      }

      const orderIds = orders.map(o => o.id);
      const members = await sequelize.query<MatchedMember>(MATCHED_MEMBERS_QUERY, {
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

      if (membersDeleted.length) {
        await sequelize.query(`UPDATE "Members" SET "deletedAt" = NOW() WHERE id IN (:ids)`, {
          replacements: { ids: membersDeleted.map(m => m.id) },
          transaction,
        });
      }

      // Orders: back to custom contribution, with the tier pending for the ones that can still be charged
      const requestedAt = new Date().toISOString();
      await sequelize.query(
        `
        UPDATE "Orders"
        SET
          "TierId" = NULL,
          "updatedAt" = NOW(),
          "data" = CASE
            WHEN status IN (:chargeableStatuses) THEN JSONB_SET(
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
      `,
        {
          replacements: { orderIds, chargeableStatuses: CHARGEABLE_STATUSES, requestedAt, source: MIGRATION_NAME },
          transaction,
        },
      );

      const data: MigrationData = { orders, membersMovedToNoTier, membersDeleted };
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

      const { orders, membersMovedToNoTier, membersDeleted } = migrationLog.data;
      for (const order of orders) {
        await sequelize.query(
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
        `,
          {
            replacements: {
              id: order.id,
              TierId: order.TierId,
              pendingTierChange: order.pendingTierChange ? JSON.stringify(order.pendingTierChange) : null,
            },
            transaction,
          },
        );
      }

      for (const member of membersMovedToNoTier) {
        await sequelize.query(`UPDATE "Members" SET "TierId" = :TierId, "updatedAt" = NOW() WHERE id = :id`, {
          replacements: { id: member.id, TierId: member.TierId },
          transaction,
        });
      }

      if (membersDeleted.length) {
        await sequelize.query(`UPDATE "Members" SET "deletedAt" = NULL WHERE id IN (:ids)`, {
          replacements: { ids: membersDeleted.map(m => m.id) },
          transaction,
        });
      }

      await sequelize.query(`DELETE FROM "MigrationLogs" WHERE id = :id`, {
        replacements: { id: migrationLog.id },
        transaction,
      });
    });
  },
};
