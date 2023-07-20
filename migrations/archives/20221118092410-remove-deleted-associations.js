'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [result] = await queryInterface.sequelize.query(
      `
      WITH deleted_expenses AS (
        UPDATE "Expenses" e
        SET "deletedAt" = NOW()
        FROM "Collectives" c
        WHERE e."deletedAt" IS NULL
        AND c."deletedAt" IS NOT NULL
        AND (e."CollectiveId" = c.id OR e."FromCollectiveId" = c.id)
        RETURNING e.id
      ), deleted_comments AS (
        UPDATE "Comments" comment
        SET "deletedAt" = NOW()
        FROM "Collectives" c
        WHERE comment."deletedAt" IS NULL
        AND c."deletedAt" IS NOT NULL
        AND (comment."CollectiveId" = c.id OR comment."FromCollectiveId" = c.id)
        RETURNING comment.id
      ), deleted_applications AS (
        UPDATE "Applications" app
        SET "deletedAt" = NOW()
        FROM "Collectives" c
        WHERE app."deletedAt" IS NULL
        AND c."deletedAt" IS NOT NULL
        AND app."CollectiveId" = c.id
        RETURNING app.id
      ) SELECT
        (SELECT ARRAY_AGG(DISTINCT id) FROM deleted_expenses) AS "deletedExpenses",
        (SELECT ARRAY_AGG(DISTINCT id) FROM deleted_comments) AS "deletedComments",
        (SELECT ARRAY_AGG(DISTINCT id) FROM deleted_applications) AS "deletedApplications"
    `,
      {
        type: queryInterface.sequelize.QueryTypes.SELECT,
      },
    );

    await queryInterface.sequelize.query(
      `
      INSERT INTO "MigrationLogs"
      ("createdAt", "type", "description", "CreatedByUserId", "data")
      VALUES (NOW(), 'MIGRATION', 'Remove deleted associations', NULL, :data)
    `,
      {
        replacements: { data: JSON.stringify(result) },
        type: queryInterface.sequelize.QueryTypes.INSERT,
      },
    );
  },

  async down() {
    console.log('Rollback must be done manually by looking at the MigrationLogs entry');
  },
};
