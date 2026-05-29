'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "PlatformSubscriptions"
      SET "plan" = JSONB_SET("plan", '{pricing,platformTips}', 'true')
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "PlatformSubscriptions"
      SET "plan" = JSONB_SET("plan", '{pricing,platformTips}', 'false')
    `);
  },
};
