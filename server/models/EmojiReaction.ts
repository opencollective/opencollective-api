import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';

import { REACTION_EMOJI, ReactionEmoji } from '../constants/reaction-emoji';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import User from './User';

class EmojiReaction extends Model<InferAttributes<EmojiReaction>, InferCreationAttributes<EmojiReaction>> {
  public declare readonly id: CreationOptional<number>;
  public declare UserId: ForeignKey<User['id']>;
  public declare FromCollectiveId: number;
  public declare CommentId: number;
  public declare UpdateId: number;
  public declare emoji: ReactionEmoji;
  public declare createdAt: Date;
  public declare updatedAt: Date;

  static async addReactionOnComment(user, commentId: number, emoji: ReactionEmoji) {
    try {
      return await EmojiReaction.create({
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CommentId: commentId,
        emoji,
      });
    } catch (e) {
      // Don't scream if the reaction already exists
      if (e.name === 'SequelizeUniqueConstraintError') {
        return EmojiReaction.findOne({
          where: {
            UserId: user.id,
            FromCollectiveId: user.CollectiveId,
            CommentId: commentId,
            emoji,
          },
        });
      } else {
        throw e;
      }
    }
  }

  static async addReactionOnUpdate(user, updateId, emoji: ReactionEmoji) {
    try {
      return await EmojiReaction.create({
        UserId: user.id,
        FromCollectiveId: user.CollectiveId,
        UpdateId: updateId,
        emoji,
      });
    } catch (e) {
      // Don't scream if the reaction already exists
      if (e.name === 'SequelizeUniqueConstraintError') {
        return EmojiReaction.findOne({
          where: {
            UserId: user.id,
            FromCollectiveId: user.CollectiveId,
            UpdateId: updateId,
            emoji,
          },
        });
      } else {
        throw e;
      }
    }
  }
}

EmojiReaction.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    FromCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    CommentId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Comments' },
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
    },
    UpdateId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Updates' },
      onDelete: 'NO ACTION',
      onUpdate: 'CASCADE',
    },
    emoji: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: {
          args: [REACTION_EMOJI],
          msg: `Must be in ${REACTION_EMOJI}`,
        },
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
  },
  {
    sequelize,
    tableName: 'EmojiReactions',
    getterMethods: {
      info() {
        return {
          id: this.id,
          userId: this.UserId,
          commentId: this.CommentId,
          emoji: this.emoji,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
        };
      },
    },
  },
);

export default EmojiReaction;
