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
    // ON CONFLICT DO NOTHING keeps the insert idempotent: a rerun after the enum add (or on a DB
    // where the account already exists) must not abort on the already-present 'platform-tips' slug.
    await queryInterface.sequelize.query(`
      INSERT INTO "Collectives" ("type", "slug", "name", "description", "website", "currency", "createdAt", "updatedAt")
      VALUES (
        'PLATFORM',
        'platform-tips',
        'Platform Tips',
        'Holds platform tips collected on behalf of the Open Collective platform',
        'https://opencollective.com',
        'USD',
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
