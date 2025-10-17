'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityActivitySummary";`);
    await queryInterface.sequelize.query(`
      CREATE MATERIALIZED VIEW "CommunityActivitySummary" as (
        WITH
          relevant_activities AS (
            -- User Relations
            SELECT
              "HostCollectiveId",
              NULL as "UserId",
              "FromCollectiveId",
              "CollectiveId",
              "type",
              "createdAt",
              (CASE
                WHEN "type" IN ('order.processed', 'ticket.confirmed') THEN 'CONTRIBUTOR'
                WHEN "type" = 'collective.expense.paid' AND 'GRANT' = ANY (ARRAY_AGG("data" #>> '{expense,type}'))
                  THEN 'GRANTEE'
                WHEN "type" = 'collective.expense.paid' THEN 'PAYEE'
                WHEN "type" = 'collective.expense.created' THEN 'EXPENSE_SUBMITTER'
                END) AS "relations"
            FROM "Activities"
            WHERE "type" IN
                  ('order.processed', 'collective.expense.approved', 'collective.expense.paid', 'collective.expense.created',
                  'ticket.confirmed')
            GROUP BY
              "HostCollectiveId", "UserId", "FromCollectiveId", "CollectiveId", "type", "createdAt"
            UNION ALL
            -- Admin Relations
            SELECT
              "HostCollectiveId",
              "UserId",
              NULL AS "FromCollectiveId",
              "CollectiveId",
              "type",
              "createdAt",
              (CASE
                WHEN "type" IN ('collective.expense.approved', 'collective.expense.rejected') THEN 'EXPENSE_APPROVER'
                END) AS "relations"
            FROM "Activities"
            WHERE "type" IN
                  ('collective.expense.approved', 'collective.expense.rejected')
            GROUP BY
              "HostCollectiveId", "UserId", "FromCollectiveId", "CollectiveId", "type", "createdAt"
            -- Member Roles
            UNION
            DISTINCT
            SELECT
              c."HostCollectiveId", u.id AS "UserId", m."MemberCollectiveId" AS "FromCollectiveId", c.id AS "CollectiveId",
              NULL AS "type", m."createdAt", m.role AS "relationship"
            FROM
              "Members" m
              INNER JOIN "Collectives" c ON m."CollectiveId" = c.id
              INNER JOIN "Users" u ON u."CollectiveId" = m."MemberCollectiveId"
            WHERE m."role" IN ('ADMIN', 'CONTRIBUTOR', 'ATTENDEE')
              AND m."deletedAt" IS NULL
            )
        SELECT
          ra."HostCollectiveId", ra."CollectiveId", COALESCE(ra."FromCollectiveId", u."CollectiveId") AS "FromCollectiveId",
          jsonb_agg_strict(DISTINCT ra."type") AS "activities",
          jsonb_agg_strict(DISTINCT ra.relations) AS "relations", MAX(ra."createdAt") AS "lastInteractionAt",
          MIN(ra."createdAt") AS "firstInteractionAt"
        FROM
          relevant_activities ra
          LEFT JOIN "Users" u ON u.id = ra."UserId"
        WHERE (ra."UserId" IS NOT NULL OR ra."FromCollectiveId" IS NOT NULL)
          AND ra."HostCollectiveId" IS NOT NULL
          AND ra."CollectiveId" IS NOT NULL
        GROUP BY
          ra."HostCollectiveId", ra."CollectiveId", COALESCE(ra."FromCollectiveId", u."CollectiveId")
        );
    `);
    await queryInterface.sequelize.query(
      `
        CREATE INDEX IF NOT EXISTS "community_activity_summary__collective_id" ON "CommunityActivitySummary" ("CollectiveId");
        CREATE INDEX IF NOT EXISTS "community_activity_summary__host_collective_id" ON "CommunityActivitySummary" ("HostCollectiveId");
        CREATE INDEX IF NOT EXISTS "community_activity_summary__from_collective_id" ON "CommunityActivitySummary" ("FromCollectiveId");
      `,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityActivitySummary";`);
  },
};
