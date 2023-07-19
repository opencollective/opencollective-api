'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      START TRANSACTION;

      CREATE TEMP TABLE "CollectiveWithCurrencyIssues" AS (
        SELECT c.*
        FROM "Transactions" t
        INNER JOIN "Collectives" c ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL AND c."deactivatedAt" IS NULL
        AND c."isActive" IS TRUE AND c."HostCollectiveId" IS NOT NULL AND c."approvedAt" IS NOT NULL
        WHERE t."currency" != t."hostCurrency"
        AND t."deletedAt" IS NULL
        GROUP BY c."id"
        HAVING c."settings"->'budget'->'version' IS NULL
        OR (c."settings"->'budget'->'version')::text = 'null'
      );

      UPDATE "Collectives"
        SET "settings" = '{}'::jsonb
        FROM "CollectiveWithCurrencyIssues"
        WHERE "Collectives"."settings" IS NULL
        AND "CollectiveWithCurrencyIssues"."id" = "Collectives"."id" ;

      UPDATE "Collectives"
        SET "settings" = jsonb_set("Collectives"."settings"::jsonb, '{budget}', '{"version": "v1"}'::jsonb)
        FROM "CollectiveWithCurrencyIssues"
        WHERE (
          "Collectives"."settings"->'budget'->'version' IS NULL
          OR
          ("Collectives"."settings"->'budget'->'version')::text = 'null'
        )
        AND "CollectiveWithCurrencyIssues"."id" = "Collectives"."id" ;

      DROP TABLE "CollectiveWithCurrencyIssues";

      COMMIT;
   `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      START TRANSACTION;

      CREATE TEMP TABLE "CollectiveWithBalanceV1" AS (
        SELECT c.*
        FROM "Transactions" t
        INNER JOIN "Collectives" c ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL AND c."deactivatedAt" IS NULL
        AND c."isActive" IS TRUE AND c."HostCollectiveId" IS NOT NULL AND c."approvedAt" IS NOT NULL
        WHERE t."currency" != t."hostCurrency"
        AND t."deletedAt" IS NULL
        GROUP BY c."id"
        HAVING COALESCE(TRIM('"' FROM (c."settings"->'budget'->'version')::text), null) = 'v1'
      );

      UPDATE "Collectives"
        SET "settings" = jsonb_set("Collectives"."settings"::jsonb, '{budget}', '{"version": null}'::jsonb)
        FROM "CollectiveWithBalanceV1"
        WHERE COALESCE(TRIM('"' FROM ("Collectives"."settings"->'budget'->'version')::text), null) = 'v1'
        AND "CollectiveWithBalanceV1"."id" = "Collectives"."id" ;;

      DROP TABLE "CollectiveWithBalanceV1";

      COMMIT;
   `);
  },
};
