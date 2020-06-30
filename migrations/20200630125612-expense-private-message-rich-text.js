'use strict';

import { buildSanitizerOptions, sanitizeHTML } from '../server/lib/sanitize-html';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const expenses = await queryInterface.sequelize.query(
      `SELECT "id", "privateMessage" FROM "Expenses" WHERE LENGTH("privateMessage") > 0;`,
      { type: Sequelize.QueryTypes.SELECT },
    );

    // These options will escape any existing tags to preserve the existing message
    const PRIVATE_MESSAGE_SANITIZE_OPTS = { ...buildSanitizerOptions(), disallowedTagsMode: 'escape' };

    for (const expense of expenses) {
      const sanitizedContent = sanitizeHTML(expense.privateMessage, PRIVATE_MESSAGE_SANITIZE_OPTS);
      await queryInterface.sequelize.query(
        `UPDATE "Expenses" e SET "privateMessage" = :privateMessage WHERE e.id = :id`,
        { replacements: { id: expense.id, privateMessage: sanitizedContent } },
      );
    }
  },

  down: async (queryInterface, Sequelize) => {
    // No rollback
  },
};
