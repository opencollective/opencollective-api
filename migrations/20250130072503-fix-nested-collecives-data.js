'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      WITH updated_collectives AS (
        UPDATE "Collectives"
        SET "data" =
          -- Merge "data" into nested data, to make sure newly created keys aren't dropped
          (data->'data' || data)
          -- Make sure any policy created in (data->'data'->'policies'->'EXPENSE_POLICIES') is merged with the top level policies
          || JSONB_BUILD_OBJECT(
            'policies',
            COALESCE(data->'data'->'policies', '{}') || COALESCE(data->'policies', '{}')
          )
        WHERE data ? 'data'
        RETURNING id, data
      ) INSERT INTO "MigrationLogs" ("type", "description", "createdAt", "data")
        SELECT
          'MIGRATION',
          '20250130072503-fix-nested-collecives-data',
          NOW(),
          CASE WHEN (SELECT COUNT(*) FROM updated_collectives) = 0
            THEN '[]'
            ELSE jsonb_agg(jsonb_build_object('id', id, 'data', data))
          END
        FROM updated_collectives
        RETURNING id
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "data" = data - 'data'
      WHERE data ? 'data'
    `);
  },

  async down(queryInterface, Sequelize) {
    console.log('Please look at the migration logs to see the data that was migrated');
  },
};
