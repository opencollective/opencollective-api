'use strict';

import type { DataTypes, QueryInterface } from 'sequelize';

const CommentMainRole = {
  HOST_ADMIN: 'HOST_ADMIN',
  COLLECTIVE_ADMIN: 'COLLECTIVE_ADMIN',
  FROM_COLLECTIVE_ADMIN: 'FROM_COLLECTIVE_ADMIN',
  SUBMITTER: 'SUBMITTER',
  BACKER: 'BACKER',
  PUBLIC: 'PUBLIC',
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof DataTypes) {
    // Add column to history table (column only, no row backfill)
    await queryInterface.addColumn('CommentHistories', 'mainCommenterRole', {
      type: Sequelize.STRING,
      allowNull: true,
    });

    // Add column with default 'PUBLIC' so all existing rows are immediately valid
    await queryInterface.addColumn('Comments', 'mainCommenterRole', {
      type: Sequelize.ENUM(...Object.values(CommentMainRole)),
      defaultValue: CommentMainRole.PUBLIC,
      allowNull: false,
    });

    // Backfill expense comments (best-effort using current Members data)
    await queryInterface.sequelize.query(`
      UPDATE "Comments" c
      SET "mainCommenterRole" = CASE
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = COALESCE(e."HostCollectiveId", col."HostCollectiveId")
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
            AND COALESCE(e."HostCollectiveId", col."HostCollectiveId") IS NOT NULL
        ) THEN 'HOST_ADMIN'::"enum_Comments_mainCommenterRole"
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = e."CollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'COLLECTIVE_ADMIN'
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = e."FromCollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'FROM_COLLECTIVE_ADMIN'
        WHEN c."CreatedByUserId" = e."UserId" THEN 'SUBMITTER'
        ELSE 'PUBLIC'
      END
      FROM "Expenses" e
      LEFT JOIN "Collectives" col ON col."id" = e."CollectiveId"
      WHERE c."ExpenseId" = e."id";
    `);

    // Backfill order comments
    await queryInterface.sequelize.query(`
      UPDATE "Comments" c
      SET "mainCommenterRole" = CASE
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = col."HostCollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
            AND col."HostCollectiveId" IS NOT NULL
        ) THEN 'HOST_ADMIN'::"enum_Comments_mainCommenterRole"
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = o."CollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'COLLECTIVE_ADMIN'
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = o."FromCollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'FROM_COLLECTIVE_ADMIN'
        ELSE 'PUBLIC'
      END
      FROM "Orders" o
      JOIN "Collectives" col ON col."id" = o."CollectiveId"
      WHERE c."OrderId" = o."id";
    `);

    // Backfill conversation comments
    await queryInterface.sequelize.query(`
      UPDATE "Comments" c
      SET "mainCommenterRole" = CASE
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = col."HostCollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
            AND col."HostCollectiveId" IS NOT NULL
        ) THEN 'HOST_ADMIN'::"enum_Comments_mainCommenterRole"
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = conv."CollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'COLLECTIVE_ADMIN'
        WHEN c."CreatedByUserId" = conv."CreatedByUserId" THEN 'SUBMITTER'
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = conv."CollectiveId"
            AND m."role" = 'BACKER'
            AND m."deletedAt" IS NULL
        ) THEN 'BACKER'
        ELSE 'PUBLIC'
      END
      FROM "Conversations" conv
      JOIN "Collectives" col ON col."id" = conv."CollectiveId"
      WHERE c."ConversationId" = conv."id";
    `);

    // Backfill update comments
    await queryInterface.sequelize.query(`
      UPDATE "Comments" c
      SET "mainCommenterRole" = CASE
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = col."HostCollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
            AND col."HostCollectiveId" IS NOT NULL
        ) THEN 'HOST_ADMIN'::"enum_Comments_mainCommenterRole"
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = u."CollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'COLLECTIVE_ADMIN'
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = u."CollectiveId"
            AND m."role" = 'BACKER'
            AND m."deletedAt" IS NULL
        ) THEN 'BACKER'
        ELSE 'PUBLIC'
      END
      FROM "Updates" u
      JOIN "Collectives" col ON col."id" = u."CollectiveId"
      WHERE c."UpdateId" = u."id";
    `);

    // Backfill host application comments
    await queryInterface.sequelize.query(`
      UPDATE "Comments" c
      SET "mainCommenterRole" = CASE
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = ha."HostCollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'HOST_ADMIN'::"enum_Comments_mainCommenterRole"
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = ha."CollectiveId"
            AND m."role" = 'ADMIN'
            AND m."deletedAt" IS NULL
        ) THEN 'COLLECTIVE_ADMIN'
        WHEN EXISTS (
          SELECT 1 FROM "Members" m
          WHERE m."MemberCollectiveId" = c."FromCollectiveId"
            AND m."CollectiveId" = ha."CollectiveId"
            AND m."role" = 'BACKER'
            AND m."deletedAt" IS NULL
        ) THEN 'BACKER'
        ELSE 'PUBLIC'
      END
      FROM "HostApplications" ha
      WHERE c."HostApplicationId" = ha."id";
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('Comments', 'mainCommenterRole');
    await queryInterface.removeColumn('CommentHistories', 'mainCommenterRole');
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_Comments_mainCommenterRole"`);
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_CommentHistories_mainCommenterRole"`);
  },
};
