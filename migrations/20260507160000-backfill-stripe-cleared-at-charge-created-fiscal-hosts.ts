'use strict';

import type { QueryInterface } from 'sequelize';

// Defines the boundaries of what we want to migrate
const migrationBoundaryConditions = `
  data #>> '{balanceTransaction}' IS NOT NULL
  AND "HostCollectiveId" = (SELECT id FROM "Collectives" WHERE slug = 'raft') -- only migrating raft for now, as they requested it
  AND "createdAt" >= '2025-11-06' -- https://github.com/opencollective/opencollective-api/pull/11165 deploy date
  AND (data #>> '{charge,created}') IS NOT NULL
  AND "deletedAt" IS NULL
`;

/**
 * Stripe balance reports attribute charges by charge.created (see opencollective#8803).
 * Backfill clearedAt from stored charge.created so past data matches current API behavior.
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      WITH tx_to_update AS (
          SELECT "TransactionGroup", to_timestamp((data #>> '{charge,created}')::integer) AS expected_date
          FROM "Transactions"
          WHERE ${migrationBoundaryConditions}
          AND to_timestamp((data #>> '{balanceTransaction,available_on}')::integer) = "clearedAt"
          AND to_timestamp((data #>> '{charge,created}')::integer) != "clearedAt"
      )
      UPDATE "Transactions"
      SET
        "clearedAt" = tx_to_update.expected_date,
        data = jsonb_set(data,'{dateBeforeMigration20260507160000}',to_jsonb("Transactions"."clearedAt"))
      FROM tx_to_update
      WHERE tx_to_update."TransactionGroup" = "Transactions"."TransactionGroup"
      AND "Transactions"."deletedAt" IS NULL
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "clearedAt" = (data #>> '{dateBeforeMigration20260507160000}')::timestamptz
      WHERE ${migrationBoundaryConditions}
      AND data #>> '{dateBeforeMigration20260507160000}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);
  },
};
