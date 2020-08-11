'use strict';

module.exports = {
  up: async queryInterface => {
    return queryInterface.sequelize.query(
      'ALTER TYPE "enum_MemberInvitations_role" ADD VALUE IF NOT EXISTS \'ACCOUNTANT\';',
    );
  },

  down: async queryInterface => {
    /** No rollback, `up` migration is safe because it has IF NOT EXISTS */
  },
};
