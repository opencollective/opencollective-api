'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO "PersonalTokens" ("token", "CollectiveId", "UserId", "createdAt", "updatedAt")
      SELECT
        app."apiKey" AS "token",
        app."CollectiveId" AS "CollectiveId",
        app."CreatedByUserId" AS "UserId",
        app."createdAt" AS "createdAt",
        app."updatedAt" AS "updatedAt"
      FROM "Applications" app
      WHERE
        app."type" = 'apiKey'
        AND app."apiKey" IS NOT NULL
        AND app."deletedAt" IS NULL;
    `);

    await queryInterface.sequelize.query(`
        DELETE FROM "Applications" WHERE "type" = 'apiKey';
     `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO "Applications" ("type", "apiKey",  "CollectiveId", "CreatedByUserId", "createdAt", "updatedAt")
      SELECT
        'apiKey' AS "type",
        pt."token" AS "apiKey",
        pt."CollectiveId" AS "CollectiveId",
        pt."UserId" AS "CreatedByUserId",
        pt."createdAt" AS "createdAt",
        pt."updatedAt" AS "updatedAt"
      FROM "PersonalTokens" pt
      WHERE
        pt."token" IS NOT NULL
        AND pt."deletedAt" IS NULL;
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM "PersonalTokens";
    `);
  },
};
