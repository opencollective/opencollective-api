'use strict';

/** @type {import('sequelize-cli').Migration} */

const dropView = async (queryInterface, transaction) => {
  await queryInterface.sequelize.query(`DROP MATERIALIZED VIEW IF EXISTS "AdminCommunityActivitySummary";`, {
    transaction,
  });
};

const createIndexes = async (queryInterface, transaction) => {
  await queryInterface.sequelize.query(
    `
    CREATE UNIQUE INDEX "admin_community_activity_summary__all_collective_ids"
      ON "AdminCommunityActivitySummary" ("HostCollectiveId", "FromCollectiveId", "CollectiveId");
    CREATE INDEX "admin_community_activity_summary__collective_id"
      ON "AdminCommunityActivitySummary" ("CollectiveId");
    CREATE INDEX "admin_community_activity_summary__host_collective_id"
      ON "AdminCommunityActivitySummary" ("HostCollectiveId");
    CREATE INDEX "admin_community_activity_summary__from_collective_id"
      ON "AdminCommunityActivitySummary" ("FromCollectiveId");
  `,
    { transaction },
  );
};

const createView = async (queryInterface, viewQuery, transaction) => {
  await queryInterface.sequelize.query(viewQuery, { transaction });
  await createIndexes(queryInterface, transaction);
};

const optimizedViewQuery = `
  CREATE MATERIALIZED VIEW "AdminCommunityActivitySummary" AS
  WITH
    relevant_activities AS (
      SELECT DISTINCT
        a."HostCollectiveId", a."UserId",
        COALESCE((fc.data -> 'UserCollectiveId')::integer, fc.id) AS "FromCollectiveId",
        a."CollectiveId", a.type, e.type AS "expenseType"
      FROM
        "Activities" a
        INNER JOIN "Collectives" h ON a."CollectiveId" = h.id
        LEFT JOIN "Expenses" e ON a."ExpenseId" = e.id
        LEFT JOIN "Collectives" fc ON a."FromCollectiveId" = fc.id
      WHERE h."deletedAt" IS NULL
        AND h."hasMoneyManagement"
        AND a."HostCollectiveId" IS NOT NULL
        AND a.type IN (
          'collective.expense.approved', 'collective.expense.rejected',
          'collective.expense.paid', 'collective.expense.created'
        )
    ),
    roles AS (
      SELECT
        a."HostCollectiveId",
        CASE
          WHEN a.type IN (
            'collective.expense.approved', 'collective.expense.rejected', 'collective.expense.created'
          ) AND a."UserId" IS NOT NULL THEN u."CollectiveId"
          ELSE a."FromCollectiveId"
        END AS "FromCollectiveId",
        a."CollectiveId", a.type,
        CASE
          WHEN a.type IN ('collective.expense.approved', 'collective.expense.rejected') THEN 'EXPENSE_APPROVER'
          WHEN a.type = 'collective.expense.paid' AND a."expenseType" = 'GRANT'::"enum_Expenses_type" THEN 'GRANTEE'
          WHEN a.type = 'collective.expense.paid' THEN 'PAYEE'
          WHEN a.type = 'collective.expense.created' THEN 'EXPENSE_SUBMITTER'
          ELSE NULL
        END AS relations
      FROM
        relevant_activities a
        LEFT JOIN "Users" u ON u.id = a."UserId"
      WHERE a."HostCollectiveId" IS NOT NULL
      UNION ALL
      SELECT
        c."HostCollectiveId",
        COALESCE((fc.data -> 'UserCollectiveId')::integer, fc.id) AS "FromCollectiveId",
        c.id AS "CollectiveId", NULL::character varying AS type,
        CASE WHEN m.role::text = 'BACKER'::text THEN 'CONTRIBUTOR'::character varying ELSE m.role END AS relations
      FROM
        "Members" m
        INNER JOIN "Collectives" c ON m."CollectiveId" = c.id AND c."HostCollectiveId" IS NOT NULL
        INNER JOIN "Collectives" fc ON m."MemberCollectiveId" = fc.id
      WHERE m.role::text = ANY (ARRAY ['ADMIN', 'CONTRIBUTOR', 'ATTENDEE', 'BACKER'])
        AND m."deletedAt" IS NULL
    )
  SELECT
    ra."HostCollectiveId", ra."CollectiveId", ra."FromCollectiveId",
    jsonb_agg_strict(DISTINCT ra.type) AS activities,
    jsonb_agg_strict(DISTINCT ra.relations) AS relations
  FROM roles ra
  GROUP BY ra."HostCollectiveId", ra."CollectiveId", ra."FromCollectiveId";
`;

const previousViewQuery = `
  CREATE MATERIALIZED VIEW "AdminCommunityActivitySummary" AS
  WITH
    relevant_activities AS (
      (
        SELECT
          a."HostCollectiveId", NULL::integer AS "UserId",
          COALESCE((fc.data -> 'UserCollectiveId')::integer, fc.id) AS "FromCollectiveId",
          a."CollectiveId", a.type, a."createdAt",
          CASE
            WHEN a.type IN ('order.processed', 'ticket.confirmed') THEN 'CONTRIBUTOR'
            WHEN a.type = 'collective.expense.paid' AND e.type = 'GRANT'::"enum_Expenses_type" THEN 'GRANTEE'
            WHEN a.type = 'collective.expense.paid' THEN 'PAYEE'
            WHEN a.type = 'collective.expense.created' THEN 'EXPENSE_SUBMITTER'
            ELSE NULL
          END AS relations
        FROM
          "Activities" a
          LEFT JOIN "Expenses" e ON a.type = 'collective.expense.paid' AND e.id = a."ExpenseId"
          LEFT JOIN "Collectives" fc ON a."FromCollectiveId" = fc.id
        WHERE a.type IN (
          'order.processed', 'collective.expense.approved', 'collective.expense.paid',
          'collective.expense.created', 'ticket.confirmed'
        )
        UNION ALL
        SELECT
          a."HostCollectiveId", a."UserId", NULL::integer AS "FromCollectiveId",
          a."CollectiveId", a.type, a."createdAt",
          CASE
            WHEN a.type IN ('collective.expense.approved', 'collective.expense.rejected') THEN 'EXPENSE_APPROVER'
            ELSE NULL
          END AS relations
        FROM "Activities" a
        WHERE a.type IN ('collective.expense.approved', 'collective.expense.rejected')
      )
      UNION
      SELECT
        c."HostCollectiveId", (fc.data -> 'UserId')::integer AS "UserId",
        COALESCE((fc.data -> 'UserCollectiveId')::integer, fc.id) AS "FromCollectiveId",
        c.id AS "CollectiveId", NULL::character varying AS type, m."createdAt",
        CASE WHEN m.role = 'BACKER' THEN 'CONTRIBUTOR' ELSE m.role END AS relations
      FROM
        "Members" m
        INNER JOIN "Collectives" c ON m."CollectiveId" = c.id
        INNER JOIN "Collectives" fc ON m."MemberCollectiveId" = fc.id
      WHERE m.role::text = ANY (ARRAY ['ADMIN', 'CONTRIBUTOR', 'ATTENDEE', 'BACKER'])
        AND m."deletedAt" IS NULL
    )
  SELECT
    ra."HostCollectiveId", ra."CollectiveId",
    COALESCE(ra."FromCollectiveId", u."CollectiveId") AS "FromCollectiveId",
    jsonb_agg_strict(DISTINCT ra.type) AS activities,
    jsonb_agg_strict(DISTINCT ra.relations) AS relations,
    MAX(ra."createdAt") AS "lastInteractionAt",
    MIN(ra."createdAt") AS "firstInteractionAt"
  FROM
    relevant_activities ra
    LEFT JOIN "Users" u ON u.id = ra."UserId"
  WHERE (ra."UserId" IS NOT NULL OR ra."FromCollectiveId" IS NOT NULL)
    AND ra."HostCollectiveId" IS NOT NULL
    AND ra."CollectiveId" IS NOT NULL
  GROUP BY
    ra."HostCollectiveId", ra."CollectiveId", COALESCE(ra."FromCollectiveId", u."CollectiveId");
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await dropView(queryInterface, transaction);
      await createView(queryInterface, optimizedViewQuery, transaction);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await dropView(queryInterface, transaction);
      await createView(queryInterface, previousViewQuery, transaction);
    });
  },
};
