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
        SELECT c1."id", c1."slug", c1."type", COUNT(DISTINCT c2."id") as "totalHostedCollectives"
          FROM "Collectives" as c1, "Collectives" as c2, "Members"
          WHERE "Members"."role" = 'HOST'
          AND "Members"."CollectiveId" = c2.id
          AND "Members"."MemberCollectiveId" = c1.id
          AND c2."deletedAt" IS NULL
          AND c2."deactivatedAt" IS NULL
          AND c2."isActive" = TRUE
          GROUP BY c1."id", c1."slug", c1."type";
      UPDATE "Collectives"
        SET "isHostAccount" = TRUE
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id";
      UPDATE "Collectives"
        SET "plan" = 'legacy-custom'
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id"
        AND "totalHostedCollectives" >= 25;
      UPDATE "Collectives"
        SET "plan" = 'legacy-large'
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id"
        AND "totalHostedCollectives" >= 10 AND "totalHostedCollectives" < 25;
      UPDATE "Collectives"
        SET "plan" = 'legacy-medium'
        FROM "Hosts"
        WHERE "Collectives"."id" = "Hosts"."id"
        AND "totalHostedCollectives" >= 2 AND "totalHostedCollectives" < 10;
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
