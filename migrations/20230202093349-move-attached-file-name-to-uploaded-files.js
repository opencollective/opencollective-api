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
        "name",
        CASE
          WHEN "url" ILIKE '%.pdf' THEN 'application/pdf'
          WHEN "url" ILIKE '%.png' THEN 'image/png'
          WHEN "url" ILIKE '%.jpg' OR "url" ILIKE '%.jpeg' THEN 'image/jpeg'
          WHEN "url" ILIKE '%.jfi' THEN 'image/jfi'
          WHEN "url" ILIKE '%.svg' THEN 'image/svg+xml'
          WHEN "url" ILIKE '%.csv' THEN 'text/csv'
        END,
        "createdAt",
        "createdAt",
        "CreatedByUserId",
        '{"createdFrom": "migrations/20230202093349-move-attached-file-name-to-uploaded-files.js"}'::jsonb
      FROM "ExpenseAttachedFiles"
      WHERE NOT STARTS_WITH("url", 'https://rest.opencollective.com') -- Settlement expenses
      AND NOT STARTS_WITH("url", 'https://loremflickr.com') -- To not break in dev/test envs
      AND NOT EXISTS(
          SELECT 1
          FROM "UploadedFiles"
          WHERE "url" = "ExpenseAttachedFiles"."url"
        )
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
