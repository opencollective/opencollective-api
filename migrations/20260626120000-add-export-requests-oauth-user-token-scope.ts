'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_UserTokens_scope"
      ADD VALUE IF NOT EXISTS 'exportRequests'
    `);
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_OAuthAuthorizationCodes_scope"
      ADD VALUE IF NOT EXISTS 'exportRequests'
    `);
  },

  async down() {
    // PostgreSQL does not support removing enum values safely
  },
};
