'use strict';

import { hasCompletedMigration, removeMigration } from './lib/helpers';
module.exports = {
  up: async queryInterface => {
    // Migration was renamed
    const scriptName = 'dev-20210823-change-event-members-from-backers-to-attendees.js';
    if (await hasCompletedMigration(queryInterface, scriptName)) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
      await removeMigration(queryInterface, scriptName);
      return;
    }

    await queryInterface.sequelize.query(
      `UPDATE "Members" SET "role" = 'ATTENDEE'
        FROM "Tiers" t, "Collectives" c
      WHERE c.type = 'EVENT'
        AND role != 'ATTENDEE'
        AND t.type = 'TICKET'
        AND "TierId" = t.id
        AND t."CollectiveId" = c.id`,
    );
  },

  down: async () => {
    // No rollback
  },
};
