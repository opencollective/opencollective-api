'use strict';

import type { QueryInterface } from 'sequelize';
import { QueryTypes } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    // Archived children (deactivatedAt set) left with isActive=true and approvedAt set, from two historical bugs:
    // - approving/re-hosting a parent used to re-activate its archived children (fixed by
    //   https://github.com/opencollective/opencollective-api/pull/11787)
    // - `archiveCollective` marks children as deactivated before `changeHost(null)` runs, so a failure
    //   in between leaves them flagged archived but still active and hosted

    // Children that kept transacting after their archive date are archived in name only: un-archive them
    // to match reality instead of cutting off an account that is actively used.
    const unarchived = await queryInterface.sequelize.query<{ id: number; slug: string }>(
      `
      UPDATE "Collectives" c
      SET "deactivatedAt" = NULL,
          "data" = COALESCE(c."data", '{}') - 'archivedFromParent'
      WHERE c."deletedAt" IS NULL
      AND c."deactivatedAt" IS NOT NULL
      AND c."ParentCollectiveId" IS NOT NULL
      AND c."isActive" IS TRUE
      AND c."approvedAt" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "Transactions" t
        WHERE t."CollectiveId" = c.id
        AND t."deletedAt" IS NULL
        AND t."createdAt" > c."deactivatedAt"
        AND t."createdAt" > NOW() - INTERVAL '12 months'
      )
      RETURNING c.id, c.slug
      `,
      { type: QueryTypes.SELECT },
    );

    // The rest are dormant: complete the archive by aligning them with the regular archived-children
    // state (inactive and unapproved, host link preserved).
    const archived = await queryInterface.sequelize.query<{ id: number }>(
      `
      UPDATE "Collectives"
      SET "isActive" = FALSE, "approvedAt" = NULL
      WHERE "deletedAt" IS NULL
      AND "deactivatedAt" IS NOT NULL
      AND "ParentCollectiveId" IS NOT NULL
      AND "isActive" IS TRUE
      AND "approvedAt" IS NOT NULL
      RETURNING id
      `,
      { type: QueryTypes.SELECT },
    );

    console.log(
      `Un-archived ${unarchived.length} children still in use (${unarchived.map(c => c.slug).join(', ')}), completed the archive of ${archived.length}`,
    );
  },

  async down() {
    // Data fix, nothing to revert
  },
};
