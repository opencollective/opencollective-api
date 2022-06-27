/* This migration is archived */

/* This migration is commented becaused it contained live code that is not supported anynmore */

/*

'use strict';
import roles from '../server/constants/roles';
import models from '../server/models';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Fetch all transactions where a gift card was used but no member associated
    const fetchedQuery = await queryInterface.sequelize.query(
      `
      SELECT
        t."CreatedByUserId",
        c.id as "CollectiveId",
        ct.id as "TargetCollectiveId",
        o."TierId"
      FROM        "Transactions" t
      LEFT JOIN   "Members" m
        ON m."MemberCollectiveId" = t."UsingVirtualCardFromCollectiveId"
        AND m."CollectiveId" = t."CollectiveId"
      INNER JOIN  "Orders" o ON o.id = t."OrderId"
      INNER JOIN  "Collectives" c ON c.id = t."UsingVirtualCardFromCollectiveId"
      INNER JOIN  "Collectives" ct ON ct.id = t."CollectiveId"
      WHERE       t."UsingVirtualCardFromCollectiveId" IS NOT null
      AND         t.type = 'CREDIT'
      AND         m.id IS NULL
      GROUP BY    t."CreatedByUserId", c.id , ct.id, o."TierId";
    `,
      queryInterface.sequelize.QueryTypes.SELECT,
    );

    // Bulk-insert the members
    const newMembersParams = fetchedQuery[1].rows.map(
      ({ CreatedByUserId, CollectiveId, TargetCollectiveId, TierId }) => {
        return {
          role: roles.BACKER,
          CreatedByUserId,
          CollectiveId: TargetCollectiveId,
          MemberCollectiveId: CollectiveId,
          TierId,
        };
      },
    );

    await models.Member.bulkCreate(newMembersParams, { returning: false });
  },

  down: (queryInterface, Sequelize) => {
  },
};

*/
