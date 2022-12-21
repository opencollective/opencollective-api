import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute, Op } from 'sequelize';
import Temporal from 'sequelize-temporal';

import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import User from './User';
import models from '.';

// Options for sanitizing comment's body
const sanitizeOptions = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
  images: true,
});

class Comment extends Model<InferAttributes<Comment>, InferCreationAttributes<Comment>> {
  public declare readonly id: CreationOptional<number>;
  public declare CollectiveId: number;
  public declare FromCollectiveId: number;
  public declare CreatedByUserId: ForeignKey<User['id']>;
  public declare ExpenseId: number;
  public declare UpdateId: number;
  public declare ConversationId: number;
  public declare html: string;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;

  public declare fromCollective?: NonAttribute<typeof models.Collective>;
  public declare collective?: NonAttribute<typeof models.Collective>;

  // Returns the User model of the User that created this Update
  getUser = function () {
    return models.User.findByPk(this.CreatedByUserId);
  };

  /**
   * Getters
   */
  get info(): NonAttribute<Partial<Comment>> {
    return {
      id: this.id,
      html: this.html,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  get minimal(): NonAttribute<Partial<Comment>> {
    return {
      id: this.id,
      createdAt: this.createdAt,
    };
  }

  get activity(): NonAttribute<Partial<Comment>> {
    return {
      id: this.id,
      createdAt: this.createdAt,
    };
  }
}

Comment.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
    },

    FromCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    ExpenseId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Expenses',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    UpdateId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Updates',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    ConversationId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Conversations' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    html: {
      type: DataTypes.TEXT,
      set(value: string) {
        if (value) {
          const cleanHtml = sanitizeHTML(value, sanitizeOptions).trim();
          this.setDataValue('html', cleanHtml);
        }
      },
    },

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    paranoid: true,
    hooks: {
      beforeCreate: instance => {
        if (!instance.ExpenseId && !instance.UpdateId && !instance.ConversationId) {
          throw new Error('Comment must be linked to an expense, an update or a conversation');
        }
      },
      beforeDestroy: async (comment, options) => {
        if (comment.ConversationId) {
          const transaction = options.transaction;
          const conversation = await models.Conversation.findOne({ where: { RootCommentId: comment.id }, transaction });
          if (conversation) {
            await conversation.destroy();
            await models.Comment.destroy({
              where: { id: { [Op.not]: comment.id }, ConversationId: conversation.id },
              transaction,
            });
          }
        }
      },
      afterUpdate: async (comment, options) => {
        if (comment.ConversationId) {
          const transaction = options.transaction;
          const conversation = await models.Conversation.findOne({ where: { RootCommentId: comment.id }, transaction });
          if (conversation) {
            await conversation.update({ summary: comment.html }, { transaction });
          }
        }
      },
    },
  },
);

Temporal(Comment, sequelize);

export default Comment;
