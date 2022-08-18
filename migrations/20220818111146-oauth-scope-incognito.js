'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_OAuthAuthorizationCodes_scope" ADD VALUE 'incognito' AFTER 'connectedAccounts';`,
    );
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_UserTokens_scope" ADD VALUE 'incognito' AFTER 'connectedAccounts';`,
    );
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'incognito' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_OAuthAuthorizationCodes_scope'
     );`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'incognito' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_UserTokens_scope'
     );`);
  },
};
