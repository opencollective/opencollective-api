'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Remove accounts from inactive collectives
    await queryInterface.sequelize.query(`
      WITH affected_accounts AS (
        SELECT ca.id
        FROM "ConnectedAccounts" ca
        INNER JOIN "Collectives" c ON ca."CollectiveId" = c.id
        WHERE ca.service = 'twitter'
        AND ca."deletedAt" IS NULL
        AND c."deletedAt" IS NULL
        AND c."isActive" IS FALSE
      ) UPDATE "ConnectedAccounts" ca
      SET
        "deletedAt" = NOW(),
        "settings" = JSONB_SET(COALESCE(ca."settings", '{}'), '{deletedByMigration20241126101027}', 'true')
      FROM affected_accounts
      WHERE ca."id" = affected_accounts.id
    `);

    // Remove accounts that have never been reconnected after the migration
    await queryInterface.sequelize.query(`
      UPDATE "ConnectedAccounts"
      SET
        "deletedAt" = NOW(),
        "settings" = JSONB_SET(COALESCE("settings", '{}'), '{deletedByMigration20241126101027}', 'true')
      WHERE service = 'twitter'
      AND "deletedAt" IS NULL
      AND (settings -> 'needsReconnect')::boolean IS TRUE
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "ConnectedAccounts"
      SET
        "deletedAt" = NULL,
        "settings" = "settings" - 'deletedByMigration20241126101027'
      WHERE service = 'twitter'
      AND "deletedAt" IS NOT NULL
      AND (settings -> 'deletedByMigration20241126101027')::boolean IS TRUE
    `);
  },
};
