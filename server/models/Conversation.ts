import slugify from 'limax';
import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import { activities } from '../constants/index.js';
import { idEncode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers.js';
import { generateSummaryForHTML } from '../lib/sanitize-html.js';
import sequelize, { DataTypes, Model, QueryTypes } from '../lib/sequelize.js';
import { sanitizeTags, validateTags } from '../lib/tags.js';

import Comment from './Comment.js';
import models, { Collective } from './index.js';
import User from './User.js';

class Conversation extends Model<InferAttributes<Conversation>, InferCreationAttributes<Conversation>> {
  public declare readonly id: CreationOptional<number>;
  public declare title: string;
  public declare slug: string;
  public declare summary: string;
  public declare tags: string[];
  public declare CollectiveId: number;
  public declare FromCollectiveId: number;
  public declare CreatedByUserId: ForeignKey<User['id']>;
  public declare RootCommentId: ForeignKey<Comment['id']>;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;

  public declare collective?: Collective;
  public declare fromCollective?: Collective;

  // ---- Static methods ----

  static createWithComment = async function (
    user: User,
    collective,
    title: string,
    html: string,
    tags = null,
  ): Promise<Conversation> {
    // Use a transaction to make sure conversation is not created if comment creation fails
    const conversation = await sequelize.transaction(async t => {
      // Create conversation
      const conversation = await Conversation.create(
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
      const comment = await Comment.create(
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
      FromCollectiveId: conversation.FromCollectiveId,
      HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
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

  static getMostPopularTagsForCollective = async function (collectiveId, limit = 100) {
    return sequelize.query(
      `
      SELECT UNNEST(tags) AS id, UNNEST(tags) AS tag, COUNT(id)
      FROM "Conversations"
      WHERE "CollectiveId" = $collectiveId
      GROUP BY UNNEST(tags)
      ORDER BY count DESC
      LIMIT $limit
    `,
      {
        type: QueryTypes.SELECT,
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
  getUsersFollowing = async function (): Promise<User[]> {
    const followers = await models.ConversationFollower.findAll({
      include: ['user'],
      where: { ConversationId: this.id, isActive: true },
    });

    return followers.map(f => f.user);
  };

  // Getters

  get hashId(): NonAttribute<string> {
    return idEncode(this.get('id'), IDENTIFIER_TYPES.CONVERSATION);
  }

  get info(): NonAttribute<Partial<Conversation>> {
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
  }
}

Conversation.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { len: [3, 255] },
      set(title: string) {
        if (title) {
          this.setDataValue('title', title.trim());
        }
      },
    },
    slug: {
      type: DataTypes.VIRTUAL(DataTypes.STRING),
      get() {
        return slugify(this.get('title') || 'conversation');
      },
    },
    summary: {
      type: DataTypes.STRING,
      allowNull: false,
      set(summary: string) {
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
      set(tags: string[] | null) {
        this.setDataValue('tags', sanitizeTags(tags));
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
    sequelize,
    paranoid: true,
  },
);

export default Conversation;
