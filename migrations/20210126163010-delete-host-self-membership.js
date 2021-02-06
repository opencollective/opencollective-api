'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      UPDATE "Members" SET "deletedAt" = NOW() WHERE "CollectiveId" = "MemberCollectiveId" AND "role" = 'HOST';
    `);
  },

  down: async (queryInterface, Sequelize) => {},
};
