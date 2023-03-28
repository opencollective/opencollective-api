'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Members"
      SET "deletedAt" = NOW()
      WHERE
      "CollectiveId" IN (SELECT id FROM "Collectives" WHERE "deletedAt" IS NULL AND "ParentCollectiveId" IS NOT NULL)
      AND "role" IN ('ADMIN', 'MEMBER', 'ACCOUNTANT')
      AND "deletedAt" IS NULL
    `);
  },

  async down() {
    //
  },
};
