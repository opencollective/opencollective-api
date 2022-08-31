'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Members" SET "deletedAt" = NOW() WHERE "CollectiveId" = "MemberCollectiveId" AND "role" = 'HOST';
    `);
  },

  down: async () => {
    // No rollback
  },
};
