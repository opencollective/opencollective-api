'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'APPLICATION_FEE' AFTER 'ADDED_FUNDS'
    `);

    // The global account that holds platform tips collected on behalf of the Open Collective
    // platform. It is a host-less PLATFORM-type account: each tip's transactions are recorded on
    // the collecting host's ledger (HostCollectiveId = host), and billing is drawn directly against
    // this account at settlement time (no per-host release transfer).
    //
    // A superseded version of this migration created the same account as a VENDOR with slug
    // 'oc-platform'. On databases that already ran it, convert that row IN PLACE so its id (and every
    // PLATFORM_TIP/APPLICATION_FEE transaction already pointing at it) is preserved — otherwise the
    // old account would be stranded and the new code (which resolves slug 'platform-tips') would see
    // an empty account. Guarded by NOT EXISTS so it never collides with an already-present
    // 'platform-tips' row (idempotent / safe if both somehow exist).
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "type" = 'PLATFORM', "slug" = 'platform-tips', "name" = 'Platform Tips', "isActive" = TRUE, "updatedAt" = NOW()
      WHERE "slug" = 'oc-platform'
        AND NOT EXISTS (SELECT 1 FROM "Collectives" WHERE "slug" = 'platform-tips');
    `);

    // Fresh databases (no legacy oc-platform row to convert): create the account. ON CONFLICT DO
    // NOTHING keeps it idempotent and a no-op when the conversion above (or a prior run) already
    // produced the 'platform-tips' row.
    await queryInterface.sequelize.query(`
      INSERT INTO "Collectives" ("type", "slug", "name", "description", "website", "currency", "isActive", "createdAt", "updatedAt")
      VALUES (
        'PLATFORM',
        'platform-tips',
        'Platform Tips',
        'Holds platform tips collected on behalf of the Open Collective platform',
        'https://opencollective.com',
        'USD',
        TRUE,
        NOW(),
        NOW()
      )
      ON CONFLICT DO NOTHING;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "Collectives" WHERE "slug" = 'platform-tips';
    `);
    // Note: enum values cannot easily be removed in Postgres; intentionally not rolling back the kind addition.
  },
};
