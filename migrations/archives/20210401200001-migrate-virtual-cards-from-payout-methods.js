'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.addColumn('Expenses', 'VirtualCardId', {
      type: DataTypes.STRING,
      references: { key: 'id', model: 'VirtualCards' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.addColumn('ExpenseHistories', 'VirtualCardId', {
      type: DataTypes.STRING,
      references: { key: 'id', model: 'VirtualCards' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      INSERT INTO "VirtualCards" (
        "id", "HostCollectiveId", "CollectiveId", "last4", "data", "createdAt", "updatedAt"
      ) SELECT
        pm."data"->>'token' AS "id",
        c."HostCollectiveId" AS "HostCollectiveId",
        pm."CollectiveId" AS "CollectiveId",
        pm."name" as "last4",
        pm."data" as "data",
        pm."createdAt" as "createdAt",
        pm."updatedAt" as "updatedAt"
      FROM
        "PayoutMethods" pm
      INNER JOIN "Collectives" c
        ON pm."CollectiveId" = c.id
      WHERE
        pm."deletedAt" IS NULL
        AND pm."type" = 'CREDIT_CARD';
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Expenses"
        SET "VirtualCardId" = "PayoutMethods"."data"->>'token', "PayoutMethodId" = null
      FROM
        "PayoutMethods"
      WHERE
        "Expenses"."deletedAt" IS NULL
        AND "Expenses"."PayoutMethodId" IS NOT NULL
        AND "Expenses"."PayoutMethodId" = "PayoutMethods"."id"
        AND "PayoutMethods"."type" = 'CREDIT_CARD';
    `);

    await queryInterface.sequelize.query(`
      DELETE FROM "PayoutMethods" WHERE "type" = 'CREDIT_CARD';
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DELETE FROM "VirtualCards";
    `);

    await queryInterface.removeColumn('Expenses', 'VirtualCardId');
    await queryInterface.removeColumn('ExpenseHistories', 'VirtualCardId');
  },
};
