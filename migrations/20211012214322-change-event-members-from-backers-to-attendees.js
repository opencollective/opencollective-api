'use strict';

module.exports = {
  up: async queryInterface => {
    const scriptName = 'dev-20210823-change-event-members-from-backers-to-attendees.js';
    const [, result] = await queryInterface.sequelize.query(`
      SELECT name from "SequelizeMeta" WHERE name='${scriptName}';
    `);

    if (result.rowCount === 1) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
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
