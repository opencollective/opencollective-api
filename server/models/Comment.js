import Temporal from 'sequelize-temporal';

import { buildSanitizerOptions, sanitizeHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes } from '../lib/sequelize';

// Options for sanitizing comment's body
const sanitizeOptions = buildSanitizerOptions({
  basicTextFormatting: true,
  multilineTextFormatting: true,
  links: true,
  images: true,
});

function defineModel() {
  const { models } = sequelize;

  const Comment = sequelize.define(
    'Comment',
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
        set(value) {
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
      paranoid: true,

      getterMethods: {
        // Info.
        info() {
          return {
            id: this.id,
            title: this.title,
            html: this.html,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
          };
        },
        minimal() {
          return {
            id: this.id,
            createdAt: this.createdAt,
          };
        },
        activity() {
          return {
            id: this.id,
            createdAt: this.createdAt,
          };
        },
      },

      hooks: {
        beforeCreate: instance => {
          if (!instance.ExpenseId && !instance.UpdateId && !instance.ConversationId) {
            throw new Error('Comment must be linked to an expense, an update or a conversation');
          }
        },
      },
    },
  );

  Comment.prototype._internalDestroy = Comment.prototype.destroy;
  Comment.prototype._internalUpdate = Comment.prototype.update;

  Comment.prototype.destroy = async function () {
    // If comment is the root comment of a conversation, we delete the conversation and all linked comments
    if (this.ConversationId) {
      const conversation = await models.Conversation.findOne({ where: { RootCommentId: this.id } });
      if (conversation) {
        await conversation.destroy();
        await models.Comment.destroy({ where: { ConversationId: conversation.id } });
        return this;
      }
    }

    return this._internalDestroy(...arguments);
  };

  Comment.prototype.update = async function (values, sequelizeOpts, ...args) {
    if (!this.ConversationId) {
      return this._internalUpdate(values, sequelizeOpts, ...args);
    }

    // If comment is the root comment of a conversation, we need tu update its summary
    const withTransaction = func =>
      sequelizeOpts && sequelizeOpts.transaction ? func(sequelizeOpts.transaction) : sequelize.transaction(func);

    return withTransaction(async transaction => {
      const conversation = await models.Conversation.findOne({ where: { RootCommentId: this.id } }, { transaction });
      if (conversation) {
        await conversation.update({ summary: values.html }, { transaction });
      }

      return this._internalUpdate(values, { ...sequelizeOpts, transaction }, ...args);
    });
  };

  // Returns the User model of the User that created this Update
  Comment.prototype.getUser = function () {
    return models.User.findByPk(this.CreatedByUserId);
  };

  Temporal(Comment, sequelize);

  return Comment;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Comment = defineModel();

export default Comment;
