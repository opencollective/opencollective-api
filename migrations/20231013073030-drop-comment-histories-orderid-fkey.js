'use strict';

/**
 * Similar to https://github.com/opencollective/opencollective-api/blob/452c5192576104a912d581b0d96fcc4ca37facfa/migrations/20221211211133-fix-model-history-tables.js,
 * the tests were failing because of the foreign key constraint on CommentHistories.OrderId.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "CommentHistories"
      DROP CONSTRAINT IF EXISTS "CommentHistories_OrderId_fkey"
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "CommentHistories"
      ADD CONSTRAINT "CommentHistories_OrderId_fkey" FOREIGN KEY ("OrderId") REFERENCES "Orders" ("id") ON DELETE CASCADE;
    `);
  },
};
