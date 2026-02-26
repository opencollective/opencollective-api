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
              a."HostCollectiveId", NULL AS "UserId", a."FromCollectiveId", a."CollectiveId", a."type", a."createdAt",
              (CASE
                WHEN a."type" IN ('order.processed', 'ticket.confirmed') THEN 'CONTRIBUTOR'
                WHEN a."type" = 'collective.expense.paid' AND e."type" = 'GRANT' THEN 'GRANTEE'
                WHEN a."type" = 'collective.expense.paid' THEN 'PAYEE'
                WHEN a."type" = 'collective.expense.created' THEN 'EXPENSE_SUBMITTER' END) AS "relations"
            FROM
              "Activities" a
              LEFT JOIN "Expenses" e ON a.type = 'collective.expense.paid' AND e.id = a."ExpenseId"
            WHERE a."type" IN ('order.processed', 'collective.expense.approved', 'collective.expense.paid', 'collective.expense.created',
                              'ticket.confirmed')
            UNION ALL
            -- Admin Relations
            SELECT
              a."HostCollectiveId", a."UserId", NULL AS "FromCollectiveId", a."CollectiveId", a."type", a."createdAt",
              (CASE WHEN a."type" IN ('collective.expense.approved', 'collective.expense.rejected') THEN 'EXPENSE_APPROVER' END) AS "relations"
            FROM "Activities" a
            WHERE a."type" IN ('collective.expense.approved', 'collective.expense.rejected')
            -- Member Roles
            UNION
            DISTINCT
            SELECT
              c."HostCollectiveId", u.id AS "UserId", m."MemberCollectiveId" AS "FromCollectiveId", c.id AS "CollectiveId", NULL AS "type", m."createdAt",
              (CASE WHEN m.role = 'BACKER' THEN 'CONTRIBUTOR' ELSE m.role END) AS "relations"
            FROM
              "Members" m
              INNER JOIN "Collectives" c ON m."CollectiveId" = c.id
              LEFT JOIN "Users" u ON u."CollectiveId" = m."MemberCollectiveId"
            WHERE m."role" IN ('ADMIN', 'CONTRIBUTOR', 'ATTENDEE', 'BACKER')
              AND m."deletedAt" IS NULL
            )
        SELECT
          ra."HostCollectiveId", ra."CollectiveId", COALESCE(ra."FromCollectiveId", u."CollectiveId") AS "FromCollectiveId", jsonb_agg_strict(DISTINCT ra."type") AS "activities",
          jsonb_agg_strict(DISTINCT ra.relations) AS "relations", MAX(ra."createdAt") AS "lastInteractionAt", MIN(ra."createdAt") AS "firstInteractionAt"
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
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "community_activity_summary__all_collective_ids"
      ON "CommunityActivitySummary"("HostCollectiveId", "FromCollectiveId", "CollectiveId");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "community_activity_summary__all_collective_ids";`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "community_activity_summary__collective_id";`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "community_activity_summary__host_collective_id";`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "community_activity_summary__from_collective_id";`);
    await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "CommunityActivitySummary";`);
  },
};
