'use strict';

import { buildSanitizerOptions, sanitizeHTML } from '../server/lib/sanitize-html';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const expenseItems = await queryInterface.sequelize.query(
      `
        SELECT "id", "description" FROM "ExpenseItems"
        WHERE LENGTH("description") > 0 AND "description" LIKE '%<%'
        AND "deletedAt" IS NULL;
      `,
      { type: Sequelize.QueryTypes.SELECT },
    );

    const sanitizeOptions = buildSanitizerOptions({
      titles: true,
      basicTextFormatting: true,
      multilineTextFormatting: true,
      images: true,
      links: true,
    });

    for (const expenseItem of expenseItems) {
      const sanitizedContent = sanitizeHTML(expenseItem.description, sanitizeOptions);
      await queryInterface.sequelize.query(
        `
        UPDATE "ExpenseItems" e
        SET "description" = :description
        WHERE e.id = :id
      `,
        {
          replacements: {
            description: sanitizedContent,
            id: expenseItem.id,
          },
        },
      );
    }
  },

  down: async () => {
    // can't rollback this one
  },
};
