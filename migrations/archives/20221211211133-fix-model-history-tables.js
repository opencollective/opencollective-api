'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    /** CollectiveHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "CollectiveHistories"
      ADD COLUMN IF NOT EXISTS "searchTsVector" tsvector,
      DROP CONSTRAINT IF EXISTS "CollectiveHistories_CreatedByUserId_fkey",
      DROP CONSTRAINT IF EXISTS "CollectiveHistories_HostCollectiveId_fkey",
      DROP CONSTRAINT IF EXISTS "CollectiveHistories_ParentCollectiveId_fkey";
    `);

    /** CommentHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "CommentHistories"
      ALTER COLUMN "CollectiveId" DROP NOT NULL,
      ALTER COLUMN "CreatedByUserId" DROP NOT NULL,
      ALTER COLUMN "FromCollectiveId" DROP NOT NULL,
      DROP CONSTRAINT IF EXISTS "CommentHistories_CollectiveId_fkey",
      DROP CONSTRAINT IF EXISTS "CommentHistories_ConversationId_fkey",
      DROP CONSTRAINT IF EXISTS "CommentHistories_CreatedByUserId_fkey",
      DROP CONSTRAINT IF EXISTS "CommentHistories_ExpenseId_fkey",
      DROP CONSTRAINT IF EXISTS "CommentHistories_FromCollectiveId_fkey",
      DROP CONSTRAINT IF EXISTS "CommentHistories_UpdateId_fkey";
    `);

    /** ExpenseHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "ExpenseHistories"
      DROP CONSTRAINT IF EXISTS "ExpenseHistories_FromCollectiveId_fkey",
      DROP CONSTRAINT IF EXISTS "ExpenseHistories_HostCollectiveId_fkey",
      DROP CONSTRAINT IF EXISTS "ExpenseHistories_RecurringExpenseId_fkey",
      DROP CONSTRAINT IF EXISTS "ExpenseHistories_VirtualCardId_fkey";
    `);

    /** CollectiveHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "CollectiveHistories"
      ALTER COLUMN "isHostAccount" DROP NOT NULL,
      ALTER COLUMN "isPledged" DROP NOT NULL;
    `);

    /** UpdateHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "UpdateHistories"
      ALTER COLUMN "CollectiveId" DROP NOT NULL,
      ALTER COLUMN "CreatedByUserId" DROP NOT NULL,
      ALTER COLUMN "FromCollectiveId" DROP NOT NULL,
      ALTER COLUMN "isChangelog" DROP NOT NULL,
      ALTER COLUMN "isPrivate" DROP NOT NULL,
      DROP CONSTRAINT IF EXISTS "UpdateHistories_CollectiveId_fkey",
      DROP CONSTRAINT IF EXISTS "UpdateHistories_CreatedByUserId_fkey",
      DROP CONSTRAINT IF EXISTS "UpdateHistories_FromCollectiveId_fkey",
      DROP CONSTRAINT IF EXISTS "UpdateHistories_LastEditedByUserId_fkey",
      DROP CONSTRAINT IF EXISTS "UpdateHistories_TierId_fkey";
    `);

    /** OrderHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "OrderHistories"
      ALTER COLUMN "status" DROP NOT NULL;
    `);

    /** TierHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "TierHistories"
      ALTER COLUMN "useStandalonePage" DROP NOT NULL;
    `);
  },

  async down(queryInterface) {
    /** CollectiveHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "CollectiveHistories"
      DROP COLUMN "searchTsVector",
      ADD CONSTRAINT "CollectiveHistories_CreatedByUserId_fkey" FOREIGN KEY ("CreatedByUserId") REFERENCES "Users"(id),
      ADD CONSTRAINT "CollectiveHistories_HostCollectiveId_fkey" FOREIGN KEY ("HostCollectiveId") REFERENCES "Collectives"(id),
      ADD CONSTRAINT "CollectiveHistories_ParentCollectiveId_fkey" FOREIGN KEY ("ParentCollectiveId") REFERENCES "Collectives"(id);
    `);

    /** CommentHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "CommentHistories"
      ALTER COLUMN "CollectiveId" SET NOT NULL,
      ALTER COLUMN "CreatedByUserId" SET NOT NULL,
      ALTER COLUMN "FromCollectiveId" SET NOT NULL,
      ADD CONSTRAINT "CommentHistories_CollectiveId_fkey" FOREIGN KEY ("CollectiveId") REFERENCES "Collectives"(id),
      ADD CONSTRAINT "CommentHistories_ConversationId_fkey" FOREIGN KEY ("ConversationId") REFERENCES "Conversations"(id),
      ADD CONSTRAINT "CommentHistories_CreatedByUserId_fkey" FOREIGN KEY ("CreatedByUserId") REFERENCES "Users"(id),
      ADD CONSTRAINT "CommentHistories_ExpenseId_fkey" FOREIGN KEY ("ExpenseId") REFERENCES "Expenses"(id),
      ADD CONSTRAINT "CommentHistories_FromCollectiveId_fkey" FOREIGN KEY ("FromCollectiveId") REFERENCES "Collectives"(id),
      ADD CONSTRAINT "CommentHistories_UpdateId_fkey" FOREIGN KEY ("UpdateId") REFERENCES "Updates"(id);
    `);

    /** ExpenseHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "ExpenseHistories"
      ADD CONSTRAINT "ExpenseHistories_FromCollectiveId_fkey" FOREIGN KEY ("FromCollectiveId") REFERENCES "Collectives"(id),
      ADD CONSTRAINT "ExpenseHistories_HostCollectiveId_fkey" FOREIGN KEY ("HostCollectiveId") REFERENCES "Collectives"(id),
      ADD CONSTRAINT "ExpenseHistories_RecurringExpenseId_fkey" FOREIGN KEY ("RecurringExpenseId") REFERENCES "Expenses"(id),
      ADD CONSTRAINT "ExpenseHistories_VirtualCardId_fkey" FOREIGN KEY ("VirtualCardId") REFERENCES "VirtualCards"(id);
    `);

    /** CollectiveHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "CollectiveHistories"
      ALTER COLUMN "isHostAccount" SET NOT NULL,
      ALTER COLUMN "isPledged" SET NOT NULL;
    `);

    /** UpdateHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "UpdateHistories"
      ALTER COLUMN "CollectiveId" SET NOT NULL,
      ALTER COLUMN "CreatedByUserId" SET NOT NULL,
      ALTER COLUMN "FromCollectiveId" SET NOT NULL,
      ALTER COLUMN "isChangelog" SET NOT NULL,
      ALTER COLUMN "isPrivate" SET NOT NULL,
      ADD CONSTRAINT "UpdateHistories_CollectiveId_fkey" FOREIGN KEY ("CollectiveId") REFERENCES "Collectives"(id),
      ADD CONSTRAINT "UpdateHistories_CreatedByUserId_fkey" FOREIGN KEY ("CreatedByUserId") REFERENCES "Users"(id),
      ADD CONSTRAINT "UpdateHistories_FromCollectiveId_fkey" FOREIGN KEY ("FromCollectiveId") REFERENCES "Collectives"(id),
      ADD CONSTRAINT "UpdateHistories_LastEditedByUserId_fkey" FOREIGN KEY ("LastEditedByUserId") REFERENCES "Users"(id),
      ADD CONSTRAINT "UpdateHistories_TierId_fkey" FOREIGN KEY ("TierId") REFERENCES "Tiers"(id);
    `);

    /** OrderHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "OrderHistories"
      ALTER COLUMN "status" SET NOT NULL;
    `);

    /** TierHistories */
    await queryInterface.sequelize.query(`
      ALTER TABLE "TierHistories"
      ALTER COLUMN "useStandalonePage" SET NOT NULL;
    `);
  },
};
