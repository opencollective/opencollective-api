import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, Model, NonAttribute } from 'sequelize';

import sequelize, { DataTypes } from '../lib/sequelize';

import Conversation from './Conversation';
import User from './User';

class ConversationFollower extends Model<
  InferAttributes<ConversationFollower>,
  InferCreationAttributes<ConversationFollower>
> {
  declare public readonly id: CreationOptional<number>;
  declare public UserId: ForeignKey<User['id']>;
  declare public ConversationId: ForeignKey<Conversation['id']>;
  declare public isActive: boolean;
  declare public createdAt: Date;
  declare public updatedAt: Date;

  // Associations
  declare public user?: NonAttribute<User>;
  declare public conversation?: NonAttribute<Conversation>;

  /**
   * @returns true if user follows the conversation
   */
  static isFollowing = async function (UserId: number, ConversationId: number) {
    const following = await ConversationFollower.findOne({
      where: { UserId, ConversationId, isActive: true },
      attributes: ['id'],
      mapToModel: false,
    });

    return Boolean(following);
  };

  /**
   * Creates or update the follower entry in the DB to follow the conversation
   */
  static follow = async function (UserId: number, ConversationId: number): Promise<ConversationFollower> {
    return sequelize.transaction(async transaction => {
      const following = await ConversationFollower.findOne({ where: { UserId, ConversationId }, transaction });
      if (!following) {
        return ConversationFollower.create({ UserId, ConversationId, isActive: true }, { transaction });
      } else if (!following.isActive) {
        return following.update({ isActive: true }, { transaction });
      } else {
        return following;
      }
    });
  };

  /**
   * Unfollow the conversation for user if it exists
   */
  static unfollow = async function (UserId: number, ConversationId: number): Promise<ConversationFollower> {
    return sequelize.transaction(async transaction => {
      const following = await ConversationFollower.findOne({ where: { UserId, ConversationId }, transaction });
      if (!following) {
        return ConversationFollower.create({ UserId, ConversationId, isActive: false }, { transaction });
      } else if (following.isActive) {
        return following.update({ isActive: false }, { transaction });
      } else {
        return following;
      }
    });
  };

  /**
   * Unfollow the conversation for user if it exists
   */
  static ConversationFollower = async function (UserId: number, ConversationId: number): Promise<ConversationFollower> {
    return sequelize.transaction(async transaction => {
      const following = await ConversationFollower.findOne({ where: { UserId, ConversationId }, transaction });
      if (!following) {
        return ConversationFollower.create({ UserId, ConversationId, isActive: false }, { transaction });
      } else if (following.isActive) {
        return following.update({ isActive: false }, { transaction });
      } else {
        return following;
      }
    });
  };
}

ConversationFollower.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    ConversationId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Conversations' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    // Using a dedicated column rather than deleting the follower in case the user is following
    // all the conversations for a Collective and wants to opt-out from one of them.
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false,
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
    modelName: 'ConversationFollower',
    indexes: [
      {
        fields: ['UserId', 'ConversationId'],
        unique: true,
      },
    ],
  },
);

export default ConversationFollower;
