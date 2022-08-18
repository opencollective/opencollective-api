'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_OAuthAuthorizationCodes_scope" ADD VALUE 'incognito' AFTER 'email';`,
    );
    await queryInterface.sequelize.query(`ALTER TYPE "enum_UserTokens_scope" ADD VALUE 'incognito' AFTER 'email';`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'payoutMethods' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_OAuthAuthorizationCodes_scope'
     );`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'payoutMethods' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_UserTokens_scope'
     );`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'paymentMethods' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_OAuthAuthorizationCodes_scope'
     );`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'paymentMethods' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_UserTokens_scope'
     );`);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'incognito' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_OAuthAuthorizationCodes_scope'
     );`);
    await queryInterface.sequelize.query(`DELETE FROM pg_enum WHERE enumlabel = 'incognito' AND enumtypid = (
      SELECT oid FROM pg_type WHERE typname = 'enum_UserTokens_scope'
     );`);
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_OAuthAuthorizationCodes_scope" ADD VALUE 'payoutMethods' AFTER 'root';`,
    );
    await queryInterface.sequelize.query(`ALTER TYPE "enum_UserTokens_scope" ADD VALUE 'payoutMethods' AFTER 'root';`);
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_OAuthAuthorizationCodes_scope" ADD VALUE 'paymentMethods' AFTER 'payoutMethods';`,
    );
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_UserTokens_scope" ADD VALUE 'paymentMethods' AFTER 'payoutMethods';`,
    );
  },
};
