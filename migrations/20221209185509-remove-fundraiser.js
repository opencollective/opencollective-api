'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`UPDATE "Members" SET "deletedAt" = NOW() WHERE "role" = 'FUNDRAISER'`);
    await queryInterface.removeColumn('Orders', 'ReferralCollectiveId');
  },

  async down() {
    console.log(`No rollback for this migration (20221209185509-remove-fundraiser.js)`);
  },
};
