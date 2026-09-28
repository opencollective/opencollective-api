'use strict';

/**
 * Prepaid budgets are being retired: orders on the `prepaid-budget` tier of `opensource`,
 * `foundation` and `europe` used to create a prepaid payment method (see the removed
 * `server/lib/prepaid-budget.js`). That code is gone, so the tier must stop being sold:
 * we only want to keep showing the history of what was bought with it.
 *
 * Unpublishing is done by setting `endsAt` in the past rather than by deleting the tier, so
 * that historical orders keep resolving their tier (see `ContributionBlocker`/`isTierExpired`,
 * which refuse contributions to expired tiers).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    const [impactedTiers] = await queryInterface.sequelize.query(
      `
      UPDATE "Tiers"
      SET "endsAt" = NOW(), "updatedAt" = NOW()
      WHERE slug = 'prepaid-budget'
        AND "deletedAt" IS NULL
        AND ("endsAt" IS NULL OR "endsAt" > NOW())
        AND "CollectiveId" IN (
          SELECT id FROM "Collectives" WHERE slug IN ('opensource', 'foundation', 'europe')
        )
      RETURNING id
    `,
      {
        type: queryInterface.sequelize.QueryTypes.UPDATE,
      },
    );

    if (impactedTiers.length > 0) {
      await queryInterface.sequelize.query(
        `
        INSERT INTO "MigrationLogs" ("type", "createdAt", "description", "data")
        VALUES ('MIGRATION', NOW(), '20260928120000-unpublish-prepaid-budget-tiers', :data)
      `,
        {
          replacements: {
            data: JSON.stringify({ tiersUpdated: impactedTiers.map(tier => tier.id) }),
          },
        },
      );
    }
  },

  async down() {
    console.log('No rollback for this migration, see MigrationLogs for the list of tiers updated');
  },
};
