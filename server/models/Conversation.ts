import slugify from 'limax';
import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import { activities } from '../constants';
import { idEncode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import { generateSummaryForHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Model, QueryTypes } from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';

import Activity from './Activity';
import Collective from './Collective';
import Comment from './Comment';
import ConversationFollower from './ConversationFollower';
import User from './User';

export enum ConversationVisibility {
  PUBLIC = 'PUBLIC',
  ADMINS_AND_HOST = 'ADMINS_AND_HOST',
}

class Conversation extends Model<InferAttributes<Conversation>, InferCreationAttributes<Conversation>> {
  declare public readonly id: CreationOptional<number>;
  declare public title: string;
  declare public slug: string;
  declare public summary: string;
  declare public tags: string[];
  declare public CollectiveId: number;
  declare public FromCollectiveId: number;
  declare public HostCollectiveId: number;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public RootCommentId: ForeignKey<Comment['id']>;
  declare public visibility: ConversationVisibility;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;

  declare public collective?: Collective;
  declare public fromCollective?: Collective;

  // ---- Static methods ----

  static createWithComment = async function (
    user: User,
    collective,
    title: string,
    html: string,
    tags = null,
    visibility = ConversationVisibility.PUBLIC,
    host?: Collective,
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
          visibility: visibility,
          HostCollectiveId: host?.id,
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
    Activity.create({
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
          visibility: conversation.visibility,
        },
      },
    });

    // Add user as a follower of the conversation
    await ConversationFollower.follow(user.id, conversation.id);
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
    const followers = await ConversationFollower.findAll({
      include: [{ association: 'user', required: true }],
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
      visibility: this.visibility,
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
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true,
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
    visibility: {
      type: DataTypes.ENUM(...Object.values(ConversationVisibility)),
      defaultValue: ConversationVisibility.PUBLIC,
      allowNull: false,
    },
  },
  {
    sequelize,
    paranoid: true,
  },
);

export default Conversation;
