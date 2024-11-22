'use strict';

import { uniq } from 'lodash';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [migrationLogs] = await queryInterface.sequelize.query(`
      SELECT data
      FROM "MigrationLogs"
      WHERE type = 'MODEL_FIX'
      AND description like 'Deleted % duplicate members'
    `);

    const allMemberIds = uniq(migrationLogs.map(log => log.data.duplicateMemberIds).flat());
    if (allMemberIds.length > 0) {
      console.log(`Restoring ${allMemberIds.length} deleted members (${allMemberIds})`);
      await queryInterface.sequelize.query(
        `
        UPDATE "Members"
        SET "deletedAt" = NULL
        WHERE "Members"."id" IN (:allMemberIds)
        AND "Members"."deletedAt" IS NOT NULL
      `,
        { replacements: { allMemberIds } },
      );
    }
  },

  async down() {
    console.log('No rollback, please use the checks to re-delete duplicate entries');
  },
};
