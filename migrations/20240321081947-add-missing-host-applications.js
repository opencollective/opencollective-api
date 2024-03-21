'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO "HostApplications" ("CollectiveId", "HostCollectiveId", "status", "message", "customData", "createdAt", "updatedAt", "CreatedByUserId")
      SELECT  
        c."id" as "CollectiveId",
        c."HostCollectiveId" as "HostCollectiveId", 
        'PENDING' as "status",  
        activity."data"->'application'->>'message' as "message",
        activity."data"->'application'->'customData' as "customData", 
        activity."createdAt" as "createdAt",
        CURRENT_TIMESTAMP as "updatedAt",  
        activity."UserId" as "CreatedByUserId"
      FROM "Collectives" c
      INNER JOIN "Activities" activity ON c."id" = activity."CollectiveId" AND c."HostCollectiveId" = activity."HostCollectiveId" AND activity.type = 'collective.apply'
      LEFT JOIN "HostApplications" ha ON c."id" = ha."CollectiveId" AND c."HostCollectiveId" = ha."HostCollectiveId"
      WHERE 
        c."approvedAt" IS NULL 
        AND c."deletedAt" IS NULL 
        AND c."HostCollectiveId" = 11004 
        AND c."isActive" IS false
        AND c."type" IN ('COLLECTIVE','FUND')
        AND ha."id" IS NULL;
  `);
  },

  async down() {
    // No down migration for this one
  },
};
