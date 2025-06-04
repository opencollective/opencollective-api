'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    return queryInterface.sequelize.query(
      'ALTER TYPE "enum_MemberInvitations_role" ADD VALUE IF NOT EXISTS \'COMMUNITY_MANAGER\';',
    );
  },

  async down(queryInterface) {
    return queryInterface.sequelize.query('ALTER TYPE "enum_MemberInvitations_role" DROP VALUE \'COMMUNITY_MANAGER\';');
  },
};
