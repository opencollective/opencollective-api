'use strict';

// See https://github.com/opencollective/opencollective/issues/7131

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Move invoice item urls to attached files
    await queryInterface.sequelize.query(`
      INSERT INTO "ExpenseAttachedFiles"
        ("url", "ExpenseId", "CreatedByUserId", "createdAt", "updatedAt")
      SELECT
        ei.url, ei."ExpenseId", ei."CreatedByUserId", ei."createdAt", NOW()
      FROM "ExpenseItems" ei, "Expenses" e
      WHERE e.id = ei."ExpenseId"
      AND e.type = 'INVOICE'
      AND ei.url IS NOT NULL
    `);

    // Remove invoice item urls
    await queryInterface.sequelize.query(`
      UPDATE "ExpenseItems" ei
      SET url = NULL
      FROM "Expenses" e
      WHERE e.id = ei."ExpenseId"
      AND e.type = 'INVOICE'
      AND ei.url IS NOT NULL
    `);
  },

  async down() {
    console.log(
      'There is no rollback for this migration. To roll it back, search for all migrated attached files by looking at the `updatedAt` column and move them back to invoice items.',
    );
  },
};
