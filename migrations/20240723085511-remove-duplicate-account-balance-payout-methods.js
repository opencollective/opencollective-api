'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH accounts_with_duplicates AS (
        SELECT "CollectiveId", MAX(id) AS "PayoutMethodIdToKeep"
        FROM "PayoutMethods"
        WHERE type = 'ACCOUNT_BALANCE'
        AND "deletedAt" IS NULL
        AND "isSaved" IS TRUE
        GROUP BY "CollectiveId"
        HAVING COUNT(*) > 1
      ) UPDATE "PayoutMethods" pm
      SET
        "isSaved" = FALSE,
        "data" = JSONB_SET("data", '{unsavedFromMigration20240723085511}', 'true')
      FROM accounts_with_duplicates
      WHERE pm."CollectiveId" = accounts_with_duplicates."CollectiveId"
      AND pm.id = accounts_with_duplicates."PayoutMethodIdToKeep"
      AND pm.type = 'ACCOUNT_BALANCE'
      AND pm."deletedAt" IS NULL
      AND pm."isSaved" IS TRUE
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "PayoutMethods" pm
      SET
        "isSaved" = TRUE,
        "data" = "data" - 'unsavedFromMigration20240723085511'
      WHERE pm.type = 'ACCOUNT_BALANCE'
      AND pm."deletedAt" IS NULL
      AND pm."isSaved" IS FALSE
      AND pm."data"->>'unsavedFromMigration20240723085511' = 'true'
    `);
  },
};
