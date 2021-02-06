'use strict';

import Promise from 'bluebird';

import { generateSummaryForHTML } from '../server/lib/sanitize-html';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Updates', 'summary', { type: Sequelize.STRING });
    await queryInterface.addColumn('UpdateHistories', 'summary', { type: Sequelize.STRING });

    const updates = await queryInterface.sequelize.query(
      `
        SELECT * FROM "Updates"
        WHERE "summary" IS NULL;
      `,
      { type: Sequelize.QueryTypes.SELECT },
    );

    // Update newly created summary column for existing update entries
    await Promise.map(updates, updateEntry =>
      queryInterface.sequelize.query(
        `
        UPDATE "Updates" u
        SET "summary" = :summary
        WHERE u.id = :id
      `,
        {
          replacements: {
            id: updateEntry.id,
            summary: generateSummaryForHTML(updateEntry.html, 240),
          },
        },
      ),
    );
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Updates', 'summary');
    await queryInterface.removeColumn('UpdateHistories', 'summary');
  },
};
