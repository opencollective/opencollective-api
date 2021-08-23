'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(
      `UPDATE "Members" SET "role" = 'ATTENDEE' FROM "Tiers" t, "Collectives" c WHERE c.type = 'EVENT' AND role != 'ATTENDEE' AND t.type = 'TICKET' AND "TierId" = t.id AND t."CollectiveId" = c.id`,
    );
  },

  down: async () => {
    // No rollback
  },
};
