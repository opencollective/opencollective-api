'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Collectives', 'isHostAccount', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });
    await queryInterface.addColumn('CollectiveHistories', 'isHostAccount', {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });
    await queryInterface.addColumn('Collectives', 'plan', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('CollectiveHistories', 'plan', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      START TRANSACTION;
      CREATE TEMP TABLE "Hosts" AS
        SELECT c1."id", c1."slug", c1."type",
          COUNT(DISTINCT c2."id") as "totalHostedCollectives",
          (
            SELECT SUM("Transactions"."amount") / 100 FROM "Transactions"
            WHERE "Transactions"."type" = 'CREDIT'
            AND "HostCollectiveId" = "c1"."id"
            AND "platformFeeInHostCurrency" = 0
          ) as "totalAddedFunds",
          (c1."settings"::jsonb ? 'paymentMethods')::boolean as "manualPayments"
          FROM "Collectives" as c1, "Collectives" as c2, "Members"
          WHERE "Members"."role" = 'HOST'
          AND "Members"."CollectiveId" = c2.id
          AND "Members"."MemberCollectiveId" = c1.id
          AND "Members"."deletedAt" IS NULL
          AND c2."deletedAt" IS NULL
          AND c2."deactivatedAt" IS NULL
          AND c2."isActive" = TRUE
          AND c2."type" = 'COLLECTIVE'
          GROUP BY c1."id", c1."slug", c1."type";
      UPDATE "Collectives"
        SET "isHostAccount" = TRUE
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id";
      UPDATE "Collectives"
        SET "plan" = 'legacy-custom-host-plan'
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id"
        AND ("manualPayments" IS TRUE OR "totalAddedFunds" > 1000)
        AND "totalHostedCollectives" > 25;
      UPDATE "Collectives"
        SET "plan" = 'legacy-large-host-plan'
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id"
        AND ("manualPayments" IS TRUE OR "totalAddedFunds" > 1000)
        AND "totalHostedCollectives" > 10 AND "totalHostedCollectives" <= 25;
      UPDATE "Collectives"
        SET "plan" = 'legacy-medium-host-plan'
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id"
        AND ("manualPayments" IS TRUE OR "totalAddedFunds" > 1000)
        AND "totalHostedCollectives" > 5 AND "totalHostedCollectives" <= 10;
      UPDATE "Collectives"
        SET "plan" = 'legacy-small-host-plan'
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id"
        AND ("manualPayments" IS TRUE OR "totalAddedFunds" > 1000)
        AND "totalHostedCollectives" >= 5;
      UPDATE "Collectives"
        SET "plan" = 'owned'
        WHERE "slug" IN ('opensource', 'europe', 'opencollective-host', 'foundation', 'opencollectiveinc');
      COMMIT;
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Collectives', 'isHostAccount');
    await queryInterface.removeColumn('CollectiveHistories', 'isHostAccount');
    await queryInterface.removeColumn('Collectives', 'plan');
    await queryInterface.removeColumn('CollectiveHistories', 'plan');
  },
};
