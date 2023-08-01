'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [, nbUpdated] = await queryInterface.sequelize.query(
      `
      UPDATE "Expenses" e
      SET
        "status" = 'CANCELED',
        "data" =
        COALESCE(e."data"::jsonb, '{}')
          || JSONB_BUILD_OBJECT('previousStatus', e.status)
          || JSONB_BUILD_OBJECT('cancelledWhileArchivedFromCollective', TRUE)
          || JSONB_BUILD_OBJECT('cancelledFromMigration', '20230728063957')
      FROM "Collectives" c
      WHERE e."CollectiveId" = c.id
      AND e."deletedAt" IS NULL
      AND c."deactivatedAt" IS NOT NULL
      AND c."deactivatedAt" > e."createdAt"
      AND e.status IN (
        'DRAFT','UNVERIFIED','PENDING','INCOMPLETE','APPROVED','ERROR'
      )
    `,
      {
        type: queryInterface.sequelize.QueryTypes.UPDATE,
      },
    );

    if (nbUpdated) {
      console.log(`Canceled ${nbUpdated} expenses for archived collectives`);
    }
  },

  async down(queryInterface) {
    const [, nbRestored] = await queryInterface.sequelize.query(
      `
      UPDATE "Expenses" e
      SET
        "status" = "data"->>'previousStatus',
        "data" = "data" - 'cancelledWhileArchivedFromCollective' - 'cancelledFromMigration' - 'previousStatus'
      WHERE "data"->>'cancelledFromMigration' = '20230728063957'
      AND "status" = 'CANCELED'
    `,
      {
        type: queryInterface.sequelize.QueryTypes.UPDATE,
      },
    );

    if (nbRestored) {
      console.log(`Restored ${nbRestored} expenses for archived collectives`);
    }
  },
};
