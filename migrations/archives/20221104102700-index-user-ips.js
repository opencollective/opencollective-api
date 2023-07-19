'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "users__creation_request_ip"
      ON "Users" USING HASH ((data#>>'{creationRequest,ip}'))
      WHERE data#>>'{creationRequest,ip}' IS NOT NULL and "deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "users__last_sign_in_ip"
      ON "Users" USING HASH ((data#>>'{lastSignInRequest,ip}'))
      WHERE data#>>'{lastSignInRequest,ip}' IS NOT NULL and "deletedAt" IS NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "users__creation_request_ip"
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "users__last_sign_in_ip"
    `);
  },
};
