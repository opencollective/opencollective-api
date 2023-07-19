'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [results] = await queryInterface.sequelize.query(`
      WITH potentially_invalid_members AS (
        SELECT m.id as "MemberId", m."MemberCollectiveId", m."CollectiveId", t.id AS "TierId"
        FROM "Members" m
        INNER JOIN "Orders" o ON m."MemberCollectiveId" = o."FromCollectiveId" AND m."CollectiveId" = o."CollectiveId"
        INNER JOIN "Tiers" t ON o."TierId" = t.id
        -- Where the order was clearly made for a ticket
        WHERE m.role = 'ATTENDEE'
        AND t.type = 'TICKET'
        -- But membership is not linked to any ticket
        AND m."TierId" IS NULL
        -- Non deleted entries
        AND m."deletedAt" IS NULL
        AND o."deletedAt" IS NULL
        AND t."deletedAt" IS NULL
      ), invalid_members AS (
        SELECT *
        FROM potentially_invalid_members
        -- Make sure there's not another valid membership for the same tier
        WHERE NOT EXISTS (
          SELECT 1
          FROM "Members" m
          WHERE m."MemberCollectiveId" = potentially_invalid_members."MemberCollectiveId"
          AND m."CollectiveId" = potentially_invalid_members."CollectiveId"
          AND m."TierId" = potentially_invalid_members."TierId"
          AND m."deletedAt" IS NULL
          AND m.role = 'ATTENDEE'
        )
      ) UPDATE "Members" m
      SET "TierId" = im."TierId"
      FROM invalid_members im
      WHERE m.id = im."MemberId"
      RETURNING m.id AS "MemberId", im."TierId"
    `);

    await queryInterface.sequelize.query(
      `
      INSERT INTO "MigrationLogs"
      ("createdAt", "type", "description", "CreatedByUserId", "data")
      VALUES (NOW(), 'MIGRATION', 'migrations/20221230100547-fix-ticket-member-tier-id', NULL, :data)
    `,
      {
        replacements: { data: JSON.stringify(results) },
        type: queryInterface.sequelize.QueryTypes.INSERT,
      },
    );
  },

  async down() {
    console.log('This migration must be manually reverted');
  },
};
