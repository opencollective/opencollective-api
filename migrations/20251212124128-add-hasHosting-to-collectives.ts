'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('CollectiveHistories', 'hasHosting', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.addColumn('Collectives', 'hasHosting', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "hasHosting" = TRUE
      WHERE "isHostAccount" = TRUE
        AND "deletedAt" IS NULL
        AND (
          "settings"->>'canHostAccounts' IS NULL
          OR ("settings"->>'canHostAccounts')::boolean != FALSE
        )
        AND (
          -- Hosts recently created normally went through a flow where enabling hosting was a conscious decision
          "createdAt" >= '2025-12-01'
          -- We only keep hosting for hosts that have hosted at least one collective in the past (intentionally not looking at deletedAt)
          OR EXISTS (
            SELECT 1 FROM "Members"
            WHERE "MemberCollectiveId" = "Collectives"."id"
              AND "CollectiveId" != "Collectives"."id"
              AND "role" = 'HOST'
          )
        )
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Collectives', 'hasHosting');
  },
};
