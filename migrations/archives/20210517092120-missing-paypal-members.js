'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      WITH missing_member_info AS (
        SELECT
          o."FromCollectiveId",
          o."CollectiveId",
          o."TierId",
          MIN(o."CreatedByUserId") AS "CreatedByUserId",
          MIN(o."createdAt") AS "createdAt" 
        FROM
          "Orders" o
        INNER JOIN "PaymentMethods" pm ON
          o."PaymentMethodId" = pm.id
        LEFT JOIN "Members" m ON
          m."MemberCollectiveId" = o."FromCollectiveId"
          AND m."CollectiveId" = o."CollectiveId"
          AND m."role" = 'BACKER'
          AND (
            o."TierId" IS NULL AND m."TierId" IS NULL
            OR m."TierId" = o."TierId"
          )
        WHERE
          pm."service" = 'paypal'
          AND pm."type" = 'subscription'
          AND m.id IS NULL
          AND o.status != 'NEW'
        GROUP BY
          o."FromCollectiveId",
          o."CollectiveId",
          o."TierId"
      ) INSERT INTO "Members"  (
        "createdAt",
        "updatedAt",
        "since",
        "CreatedByUserId",
        "MemberCollectiveId",
        "CollectiveId",
        "TierId",
        "role"
      ) SELECT
        missing_member_info."createdAt",
        missing_member_info."createdAt",
        missing_member_info."createdAt",
        missing_member_info."CreatedByUserId",
        missing_member_info."FromCollectiveId",
        missing_member_info."CollectiveId",
        missing_member_info."TierId",
        'BACKER'
      FROM
        missing_member_info
    `);
  },

  down: async () => {
    // No coming back
  },
};
