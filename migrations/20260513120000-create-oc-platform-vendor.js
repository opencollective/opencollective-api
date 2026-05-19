'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'APPLICATION_FEE' AFTER 'ADDED_FUNDS'
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO "Collectives" ("type", "slug", "name", "description", "website", "createdAt", "updatedAt")
      VALUES (
        'VENDOR',
        'oc-platform',
        'Open Collective Platform',
        'Holds platform tips collected on behalf of the Open Collective platform',
        'https://opencollective.com',
        NOW(),
        NOW()
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "Collectives" WHERE "slug" = 'oc-platform';
    `);
    // Note: enum values cannot easily be removed in Postgres; intentionally not rolling back the kind addition.
  },
};
