import slugify from 'limax';

import { activities } from '../constants';
import { idEncode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import { generateSummaryForHTML } from '../lib/sanitize-html';
import { sanitizeTags, validateTags } from '../lib/tags';

import models, { sequelize } from '.';

export default function (Sequelize, DataTypes) {
  const Conversation = Sequelize.define(
    'Conversation',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      hashId: {
        type: DataTypes.VIRTUAL(DataTypes.STRING),
        get() {
          return idEncode(this.get('id'), IDENTIFIER_TYPES.CONVERSATION);
        },
      },
      title: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: { len: [3, 255] },
        set(title) {
          if (title) {
            this.setDataValue('title', title.trim());
          }
        },
      },
      slug: {
        type: DataTypes.VIRTUAL(DataTypes.STRING),
        get() {
          return slugify(this.get('title')) || 'conversation';
        },
      },
      summary: {
        type: DataTypes.STRING,
        allowNull: false,
        set(summary) {
          this.setDataValue('summary', generateSummaryForHTML(summary, 240));
        },
      },
      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        allowNull: false,
      },
      deletedAt: {
        type: DataTypes.DATE,
      },
      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        set(tags) {
          const sanitizedTags = sanitizeTags(tags);
          if (!tags || sanitizedTags.length === 0) {
            this.setDataValue('tags', null);
          } else {
            this.setDataValue('tags', sanitizedTags);
          }
        },
        validate: { validateTags },
      },
      CollectiveId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      CreatedByUserId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Users' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      FromCollectiveId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },
      RootCommentId: {
        type: DataTypes.INTEGER,
      },
    },
    {
      paranoid: true,
      getterMethods: {
        info() {
          return {
            id: this.id,
            hashId: this.hashId,
            title: this.title,
            slug: this.slug,
            summary: this.summary,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            deletedAt: this.deletedAt,
            tags: this.tags,
            CollectiveId: this.CollectiveId,
            CreatedByUserId: this.CreatedByUserId,
            FromCollectiveId: this.FromCollectiveId,
            RootCommentId: this.RootCommentId,
          };
        },
      },
    },
  );

  // ---- Static methods ----

  Conversation.createWithComment = async function (user, collective, title, html, tags = null) {
    // Use a transaction to make sure conversation is not created if comment creation fails
    const conversation = await sequelize.transaction(async t => {
      // Create conversation
      const conversation = await models.Conversation.create(
        {
          CreatedByUserId: user.id,
          CollectiveId: collective.id,
          FromCollectiveId: user.CollectiveId,
          title: title,
          tags: tags,
          summary: html,
        },
        { transaction: t },
      );

      // Create comment
      const comment = await models.Comment.create(
        {
          CollectiveId: collective.id,
          ConversationId: conversation.id,
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          html: html,
        },
        { transaction: t },
      );

      // Need to update the conversation to link a comment
      return conversation.update({ RootCommentId: comment.id }, { transaction: t });
    });

    // Create the activity asynchronously. We do it here rather than in a hook because
    // `afterCreate` doesn't wait the end of the transaction to run, see https://github.com/sequelize/sequelize/issues/8585
    models.Activity.create({
      type: activities.COLLECTIVE_CONVERSATION_CREATED,
      UserId: conversation.CreatedByUserId,
      CollectiveId: conversation.CollectiveId,
      data: {
        conversation: {
          id: conversation.id,
          hashId: conversation.hashId,
          slug: conversation.slug,
          title: conversation.title,
          summary: conversation.summary,
          tags: conversation.tags,
          FromCollectiveId: conversation.FromCollectiveId,
          CollectiveId: conversation.CollectiveId,
          RootCommentId: conversation.RootCommentId,
          CreatedByUserId: conversation.CreatedByUserId,
        },
      },
    });

    // Add user as a follower of the conversation
    await models.ConversationFollower.follow(user.id, conversation.id);
    return conversation;
  };

  Conversation.getMostPopularTagsForCollective = async function (collectiveId, limit = 100) {
    return Sequelize.query(
      `
      SELECT UNNEST(tags) AS id, UNNEST(tags) AS tag, COUNT(id)
      FROM "Conversations"
      WHERE "CollectiveId" = $collectiveId
      GROUP BY UNNEST(tags)
      ORDER BY count DESC
      LIMIT $limit
    `,
      {
        type: Sequelize.QueryTypes.SELECT,
        bind: { collectiveId, limit },
      },
    );
  };

  // ---- Instance methods ----

  /**
   * Get a list of users who should be notified for conversation updates:
   * - Collective admins who haven't unsubscribed from the conversation
   * - Conversation followers
   */
  Conversation.prototype.getUsersFollowing = async function () {
    const followers = await models.ConversationFollower.findAll({
      include: ['user'],
      where: { ConversationId: this.id, isActive: true },
    });

    return followers.map(f => f.user);
  };

  // ---- Prepare model ----

  Conversation.associate = m => {
    Conversation.belongsTo(m.Collective, {
      foreignKey: 'CollectiveId',
      as: 'collective',
    });
    Conversation.belongsTo(m.Collective, {
      foreignKey: 'FromCollectiveId',
      as: 'fromCollective',
    });
  };

  return Conversation;
}
