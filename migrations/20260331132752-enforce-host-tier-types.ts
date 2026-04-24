'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Disable PRODUCT, SERVICE, and TICKET tiers for OCE accounts
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "settings" = jsonb_set("settings", '{disabledTierTypes}', '["PRODUCT", "SERVICE", "TICKET"]')
      WHERE "slug" IN ('europe', 'oce-foundation-usd','oce-foundation-eur')
    `);

    // Add some known exceptions
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "data" = jsonb_set(COALESCE("data", '{}'), '{allowedTierTypes}', '["TICKET"]')
      WHERE "slug" IN ('techworkersber', 'cables-of-resistance-a49287a4')
    `);

    // Transform all product/services/tickets tiers to DONATION
    // MAKE SURE WE DON'T TOUCH TICKETS for exceptions
    await queryInterface.sequelize.query(`
      UPDATE "Tiers"
      SET
        "type" = 'DONATION',
        "data" = jsonb_set(COALESCE("data", '{}'), '{typeBeforeMigration20260331132752}', to_jsonb("type"))
      WHERE "type" IN ('PRODUCT', 'SERVICE', 'TICKET')
      AND "deletedAt" IS NULL
      AND "CollectiveId" IN (
        SELECT c."id"
        FROM "Collectives" c
        INNER JOIN "Collectives" h ON h."id" = c."HostCollectiveId"
        WHERE h.slug IN ('europe', 'oce-foundation-usd','oce-foundation-eur')
        AND c."slug" NOT IN ('techworkersber', 'cables-of-resistance-a49287a4')
        AND c."deletedAt" IS NULL
        AND c."approvedAt" IS NOT NULL
      )
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Tiers"
      SET
        "type" = "data"->>'typeBeforeMigration20260331132752',
        "data" = "data" - 'typeBeforeMigration20260331132752'
      WHERE "data" ? 'typeBeforeMigration20260331132752'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "settings" = "settings" - 'disabledTierTypes'
      WHERE "settings" ? 'disabledTierTypes'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "data" = "data" - 'allowedTierTypes'
      WHERE "data" ? 'allowedTierTypes'
    `);
  },
};
