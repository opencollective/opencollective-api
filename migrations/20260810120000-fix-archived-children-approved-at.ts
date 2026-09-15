'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    // Archived (deactivated) children got `approvedAt` stamped when their parent was approved by a host
    // (see https://github.com/opencollective/opencollective-api/pull/11787), which breaks the
    // `approvedAt`/`isActive` consistency enforced by `checks/model/collectives.ts`.
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "approvedAt" = NULL
      WHERE "deletedAt" IS NULL
      AND "deactivatedAt" IS NOT NULL
      AND "ParentCollectiveId" IS NOT NULL
      AND "isActive" IS NOT TRUE
      AND "approvedAt" IS NOT NULL
    `);
  },

  async down() {
    // Data fix, nothing to revert
  },
};
