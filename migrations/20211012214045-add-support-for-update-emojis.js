'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    const scriptName = 'dev-20210621-add-support-for-update-emojis.js';
    const [, result] = await queryInterface.sequelize.query(`
      SELECT name from "SequelizeMeta" WHERE name='${scriptName}';
    `);

    if (result.rowCount === 1) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
      return;
    }

    await queryInterface.sequelize.query('ALTER TABLE "CommentReactions" RENAME TO "EmojiReactions";').then(() => {
      queryInterface.sequelize.query(
        'ALTER TABLE "EmojiReactions" RENAME CONSTRAINT "CommentReactions_CommentId_fkey" TO "EmojiReactions_CommentId_fkey";',
      );
      queryInterface.sequelize.query(
        'ALTER TABLE "EmojiReactions" RENAME CONSTRAINT "CommentReactions_FromCollectiveId_fkey" TO "EmojiReactions_FromCollectiveId_fkey";',
      );
      queryInterface.sequelize.query(
        'ALTER TABLE "EmojiReactions" RENAME CONSTRAINT "CommentReactions_UserId_fkey" TO "EmojiReactions_UserId_fkey";',
      );
      queryInterface.sequelize.query('ALTER INDEX "CommentReactions_pkey" RENAME TO "EmojiReactions_pkey";');
    });

    await queryInterface.addColumn('EmojiReactions', 'UpdateId', {
      type: DataTypes.INTEGER,
    });

    await queryInterface.sequelize.query('ALTER TABLE "EmojiReactions" ALTER COLUMN "CommentId" DROP NOT NULL;');

    await queryInterface.removeIndex('EmojiReactions', 'comment_reactions__comment_id__from_collective_id_emoji');
    await queryInterface.addIndex('EmojiReactions', ['CommentId', 'FromCollectiveId', 'emoji'], {
      unique: true,
      where: { UpdateId: null },
    });

    await queryInterface.addIndex('EmojiReactions', ['UpdateId', 'FromCollectiveId', 'emoji'], {
      indexName: `EmojiReactions_UpdateId_FromCollectiveId_Emoji`,
      unique: true,
      where: { CommentId: null },
    });
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query('ALTER TABLE "EmojiReactions" RENAME TO "CommentReactions";').then(() => {
      queryInterface.sequelize.query(
        'ALTER TABLE "CommentReactions" RENAME CONSTRAINT "EmojiReactions_CommentId_fkey" TO "CommentReactions_CommentId_fkey";',
      );
      queryInterface.sequelize.query(
        'ALTER TABLE "CommentReactions" RENAME CONSTRAINT "EmojiReactions_FromCollectiveId_fkey" TO "CommentReactions_FromCollectiveId_fkey";',
      );
      queryInterface.sequelize.query(
        'ALTER TABLE "CommentReactions" RENAME CONSTRAINT "EmojiReactions_UserId_fkey" TO "CommentReactions_UserId_fkey";',
      );
      queryInterface.sequelize.query('ALTER INDEX "EmojiReactions_pkey" RENAME TO "CommentReactions_pkey";');
    });
    await queryInterface.removeColumn('CommentReactions', 'UpdateId');
    await queryInterface.sequelize.query('DELETE FROM "CommentReactions" WHERE "CommentId" IS NULL;').then(() => {
      queryInterface.sequelize.query('ALTER TABLE "CommentReactions" ALTER COLUMN "CommentId" SET NOT NULL;');
    });
    await queryInterface.removeIndex('CommentReactions', 'emoji_reactions__comment_id__from_collective_id_emoji');
    await queryInterface.addIndex('CommentReactions', ['CommentId', 'FromCollectiveId', 'emoji'], {
      unique: true,
    });

    await queryInterface.removeIndex('EmojiReactions', ['EmojiReactions_UpdateId_FromCollectiveId_Emoji']);
  },
};
