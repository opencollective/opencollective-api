import { InferAttributes, InferCreationAttributes, Model, ModelStatic } from 'sequelize';

import sequelize, { DataTypes } from '../lib/sequelize';

import Conversation from './Conversation';
import User from './User';

interface ConversationFollowerModelStaticInterface {
  isFollowing(UserId: number, ConversationId: number): Promise<boolean>;
  follow(UserId: number, ConversationId: number): Promise<ConversationFollowerModelInterface>;
  unfollow(UserId: number, ConversationId: number): Promise<ConversationFollowerModelInterface>;
}

export interface ConversationFollowerModelInterface
  extends Model<
    InferAttributes<ConversationFollowerModelInterface>,
    InferCreationAttributes<ConversationFollowerModelInterface>
  > {
  id: number;
  UserId: number;
  ConversationId: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  // Associations
  user?: User;
  conversation?: Conversation;
}

type ConversationFollowerType = ModelStatic<ConversationFollowerModelInterface> &
  ConversationFollowerModelStaticInterface;

const ConversationFollower: ConversationFollowerType = sequelize.define(
  'ConversationFollower',
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
    indexes: [
      {
        fields: ['UserId', 'ConversationId'],
        unique: true,
      },
    ],
  },
);

// ---- Static methods ----

/**
 * @returns true if user follows the conversation
 */
ConversationFollower.isFollowing = async (UserId, ConversationId) => {
  const following = await ConversationFollower.findOne({
    where: { UserId, ConversationId, isActive: true },
    attributes: ['id'],
    mapToModel: false,
  });

  return Boolean(following);
};

/**
 * Creates or update the follower entry in the DB to follow the conversation
 *
 * @returns the `ConversationFollower` object.
 */
ConversationFollower.follow = async (UserId, ConversationId) => {
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
 *
 * @returns the `ConversationFollower` object.
 */
ConversationFollower.unfollow = async (UserId, ConversationId) => {
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

export default ConversationFollower;
