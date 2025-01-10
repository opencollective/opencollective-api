'use strict';

import logger from '../server/lib/logger';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [deletedComments] = await queryInterface.sequelize.query(`
      UPDATE "Comments"
      SET "deletedAt" = e."deletedAt"
      FROM "Expenses" e
      WHERE "Comments"."ExpenseId" IS NOT NULL
      AND "Comments"."ExpenseId" = e."id"
      AND e."deletedAt" IS NOT NULL
      AND "Comments"."deletedAt" IS NULL
      RETURNING e."id"
    `);

    const [deletedItems] = await queryInterface.sequelize.query(`
      UPDATE "ExpenseItems"
      SET "deletedAt" = e."deletedAt"
      FROM "Expenses" e
      WHERE "ExpenseItems"."ExpenseId" = e."id"
      AND e."deletedAt" IS NOT NULL
      AND "ExpenseItems"."deletedAt" IS NULL
      RETURNING e."id"
    `);

    logger.info(`Expenses: Fixed ${deletedComments.length} deleted comments, ${deletedItems.length} deleted items`);

    if (deletedComments.length === 0 || deletedItems.length === 0) {
      await queryInterface.sequelize.query(
        `
        INSERT INTO "MigrationLogs"
        ("createdAt", "type", "description", "CreatedByUserId", "data")
        VALUES (NOW(), 'MIGRATION', 'Fix deleted expense relationships', NULL, :data)
      `,
        {
          type: queryInterface.sequelize.QueryTypes.INSERT,
          replacements: {
            data: JSON.stringify({
              deletedComments,
              deletedItems,
            }),
          },
        },
      );
    }
  },

  async down() {
    console.log(`No rollback, check the MigrationLogs table for the data`);
  },
};
