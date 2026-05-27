'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" c
      SET data = COALESCE(c.data, '{}'::jsonb)
             || jsonb_build_object('UserCollectiveId', m."MemberCollectiveId")
             || jsonb_build_object('UserId', u.id)
      FROM "Members" m
      INNER JOIN "Users" u ON u."CollectiveId" = m."MemberCollectiveId" AND u."deletedAt" IS NULL
      WHERE m."CollectiveId" = c.id
        AND m.role = 'ADMIN'
        AND m."deletedAt" IS NULL
        AND c."isIncognito" = TRUE
        AND c."type" = 'USER'
        AND c."deletedAt" IS NULL
        AND (
          (c.data ->> 'UserCollectiveId') IS NULL
          OR (c.data ->> 'UserId') IS NULL
        )
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" c
      SET data = c.data - 'UserCollectiveId' - 'UserId'
      FROM "Members" m
      INNER JOIN "Users" u ON u."CollectiveId" = m."MemberCollectiveId" AND u."deletedAt" IS NULL
      WHERE m."CollectiveId" = c.id
        AND m.role = 'ADMIN'
        AND m."deletedAt" IS NULL
        AND c."isIncognito" = TRUE
        AND c."type" = 'USER'
        AND c."deletedAt" IS NULL
        AND (c.data ->> 'UserCollectiveId')::integer = m."MemberCollectiveId"
        AND (c.data ->> 'UserId')::integer = u.id
    `);
  },
};
