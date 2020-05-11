import { EMOJI_TYPES } from '../constants/emojiTypes';
import { idDecode } from '../graphql/v2/identifiers';

import models from './index';

export default function (Sequelize, DataTypes) {
  const CommentReaction = Sequelize.define(
    'CommentReaction',
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
        allowNull: false,
      },

      emoji: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          isIn: {
            args: [EMOJI_TYPES],
            msg: `Must be in ${EMOJI_TYPES}`,
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
    },
  );

  CommentReaction.addReaction = async function (user, comment, fromCollectiveId, reaction) {
    return await models.CommentReaction.create({
      UserId: user.id,
      FromCollectiveId: idDecode(fromCollectiveId.id, 'collective'),
      CommentId: idDecode(comment.id, 'comment'),
      emoji: reaction,
    });
  };

  CommentReaction.prototype.removeReaction = async function (id) {
    const commentReaction = await models.CommentReaction.findOne({ where: { CommentId: id } });
    await commentReaction.destroy();
    return commentReaction;
  };

  return CommentReaction;
}
