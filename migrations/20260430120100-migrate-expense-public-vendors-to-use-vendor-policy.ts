'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    // Map every existing host's vendor policy to USE_VENDOR_POLICY.
    //
    // - EXPENSE_PUBLIC_VENDORS = true                  -> ALL_SUBMITTERS (matches old "anyone" behavior)
    // - EXPENSE_PUBLIC_VENDORS = false (or unset)      -> HOST_ADMINS    (preserves old default)
    //
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET data = jsonb_set(
        jsonb_set(COALESCE(data, '{}'::jsonb), '{policies}', COALESCE(data->'policies', '{}'::jsonb), true),
        '{policies,USE_VENDOR_POLICY}',
        CASE
          WHEN (data#>'{policies,EXPENSE_PUBLIC_VENDORS}')::text = 'true' THEN '"ALL_SUBMITTERS"'::jsonb
          ELSE '"HOST_ADMINS"'::jsonb
        END
      )
      WHERE id IN (SELECT DISTINCT "HostCollectiveId" FROM "Collectives" WHERE "HostCollectiveId" IS NOT NULL AND "deletedAt" IS NULL)
        AND data #> '{policies,USE_VENDOR_POLICY}' IS NULL
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET data = data #- '{policies,USE_VENDOR_POLICY}'
      WHERE data #> '{policies,USE_VENDOR_POLICY}' IS NOT NULL
    `);
  },
};
