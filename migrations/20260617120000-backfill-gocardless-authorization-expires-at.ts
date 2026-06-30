'use strict';

import type { QueryInterface } from 'sequelize';

const migrationBoundaryConditions = `
  service = 'gocardless'
  AND "deletedAt" IS NULL
  AND (data #>> '{gocardless,requisition,created}') IS NOT NULL
  AND (data #>> '{gocardless,requisition,created}') ~ '^\\d{4}-\\d{2}-\\d{2}T'
  AND (data #>> '{gocardless,institution,max_access_valid_for_days}') ~ '^[1-9][0-9]*$'
`;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "ConnectedAccounts"
      SET "authorizationExpiresAt" = (
        (data #>> '{gocardless,requisition,created}')::timestamptz
        + (("data" #>> '{gocardless,institution,max_access_valid_for_days}')::integer * interval '1 day')
      )
      WHERE ${migrationBoundaryConditions}
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "ConnectedAccounts"
      SET "authorizationExpiresAt" = NULL
      WHERE service = 'gocardless'
      AND "deletedAt" IS NULL
    `);
  },
};
