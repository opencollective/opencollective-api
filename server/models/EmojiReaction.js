import { REACTION_EMOJI } from '../constants/reaction-emoji';
import sequelize, { DataTypes } from '../lib/sequelize';

const { models } = sequelize;

const EmojiReaction = sequelize.define(
  'EmojiReaction',
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
    indexes: [
      {
        unique: true,
        fields: ['CommentId', 'FromCollectiveId', 'emoji'],
      },
    ],
  },
);

EmojiReaction.addReactionOnComment = async function (user, commentId, emoji) {
  try {
    return await models.EmojiReaction.create({
      UserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CommentId: commentId,
      emoji,
    });
  } catch (e) {
    // Don't scream if the reaction already exists
    if (e.name === 'SequelizeUniqueConstraintError') {
      return models.EmojiReaction.findOne({
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
};

EmojiReaction.addReactionOnUpdate = async function (user, updateId, emoji) {
  try {
    return await models.EmojiReaction.create({
      UserId: user.id,
      FromCollectiveId: user.CollectiveId,
      UpdateId: updateId,
      emoji,
    });
  } catch (e) {
    // Don't scream if the reaction already exists
    if (e.name === 'SequelizeUniqueConstraintError') {
      return models.EmojiReaction.findOne({
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
};

export default EmojiReaction;
