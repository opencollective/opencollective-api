'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "HostCollectiveId" = id
      WHERE "isHostAccount" = true
      AND "type" = 'ORGANIZATION'
      AND "HostCollectiveId" IS NULL
    `);
  },

  async down() {
    console.log('No rollback');
  },
};
