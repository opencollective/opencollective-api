'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Move filename from ExpenseAttachedFiles to UploadedFiles
    await queryInterface.sequelize.query(`
      INSERT INTO
        "UploadedFiles" ("kind", "url", "fileName", "fileType", "createdAt", "updatedAt", "CreatedByUserId", "data")
      SELECT
        'EXPENSE_ATTACHED_FILE',
        "url",
        MAX("name"),
        CASE
          WHEN "url" ILIKE '%.pdf' THEN 'application/pdf'
          WHEN "url" ILIKE '%.png' THEN 'image/png'
          WHEN "url" ILIKE '%.jpg' OR "url" ILIKE '%.jpeg' THEN 'image/jpeg'
          WHEN "url" ILIKE '%.jfi' THEN 'image/jfi'
          WHEN "url" ILIKE '%.jfif' THEN 'image/jfif'
          WHEN "url" ILIKE '%.heic' THEN 'image/heic'
          WHEN "url" ILIKE '%.svg' THEN 'image/svg+xml'
          WHEN "url" ILIKE '%.csv' THEN 'text/csv'
          ELSE 'unknown'
        END,
        MIN("createdAt"),
        MIN("createdAt"),
        MIN("CreatedByUserId"),
        '{"createdFrom": "migrations/20230202093349-move-attached-file-name-to-uploaded-files.js"}'::jsonb
      FROM "ExpenseAttachedFiles"
      WHERE NOT STARTS_WITH("url", 'https://rest.opencollective.com') -- Settlement expenses
      AND NOT STARTS_WITH("url", 'https://loremflickr.com') -- To not break in dev/test envs
      AND NOT EXISTS(
          SELECT 1
          FROM "UploadedFiles" uf
          WHERE uf."url" = "ExpenseAttachedFiles"."url"
        )
      GROUP BY "url"
    `);

    // Drop ExpenseAttachedFiles filename column
    await queryInterface.removeColumn('ExpenseAttachedFiles', 'name');
  },

  async down(queryInterface, DataTypes) {
    // Restore ExpenseAttachedFiles filename column
    await queryInterface.addColumn('ExpenseAttachedFiles', 'name', {
      type: DataTypes.STRING,
      allowNull: true,
    });

    // Move filename from UploadedFiles to ExpenseAttachedFiles
    await queryInterface.sequelize.query(`
      UPDATE "ExpenseAttachedFiles"
      SET "name" = "UploadedFiles"."fileName"
      FROM "UploadedFiles"
      WHERE "ExpenseAttachedFiles"."url" = "UploadedFiles"."url"
    `);

    // Delete all records created by this migration
    await queryInterface.sequelize.query(`
      DELETE FROM "UploadedFiles"
      WHERE "data"->>'createdFrom' = 'migrations/20230202093349-move-attached-file-name-to-uploaded-files.js'
    `);
  },
};
