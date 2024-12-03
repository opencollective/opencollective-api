import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute, Op } from 'sequelize';
import Temporal from 'sequelize-temporal';

import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';
import Conversation from './Conversation';
import Expense from './Expense';
import HostApplication from './HostApplication';
import User from './User';

// Options for sanitizing comment's body
const sanitizeOptions = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
  images: true,
});

export enum CommentType {
  COMMENT = 'COMMENT',
  PRIVATE_NOTE = 'PRIVATE_NOTE',
}

class Comment extends Model<InferAttributes<Comment>, InferCreationAttributes<Comment>> {
  declare public readonly id: CreationOptional<number>;
  declare public CollectiveId: number;
  declare public FromCollectiveId: number;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public ExpenseId: ForeignKey<Expense['id']>;
  declare public HostApplicationId: ForeignKey<HostApplication['id']>;
  declare public OrderId: number;
  declare public UpdateId: number;
  declare public ConversationId: number;
  declare public html: string;
  declare public type: CommentType;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;

  declare public fromCollective?: NonAttribute<Collective>;
  declare public collective?: NonAttribute<Collective>;

  // Returns the User model of the User that created this Update
  getUser = function () {
    return User.findByPk(this.CreatedByUserId);
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

    HostApplicationId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'HostApplications',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },

    OrderId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Orders',
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

    type: {
      type: DataTypes.ENUM(...Object.values(CommentType)),
      defaultValue: CommentType.COMMENT,
      allowNull: false,
    },
  },
  {
    sequelize,
    paranoid: true,
    hooks: {
      beforeCreate: instance => {
        if (!instance.ExpenseId && !instance.UpdateId && !instance.ConversationId && !instance.HostApplicationId) {
          throw new Error('Comment must be linked to an expense, an update, a conversation or a host application');
        }
      },
      beforeDestroy: async (comment, options) => {
        if (comment.ConversationId) {
          const transaction = options.transaction;
          const conversation = await Conversation.findOne({ where: { RootCommentId: comment.id }, transaction });
          if (conversation) {
            await conversation.destroy();
            await Comment.destroy({
              where: { id: { [Op.not]: comment.id }, ConversationId: conversation.id },
              transaction,
            });
          }
        }
      },
      afterUpdate: async (comment, options) => {
        if (comment.ConversationId) {
          const transaction = options.transaction;
          const conversation = await Conversation.findOne({ where: { RootCommentId: comment.id }, transaction });
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
