import type OAuth2Server from '@node-oauth/oauth2-server';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import models from '.';

// Define attributes that can be used for model creation
interface UserTokenCreateAttributes {
  type: 'OAUTH';
  accessToken: string;
  accessTokenExpiresAt?: Date | undefined;
  refreshToken?: string | undefined;
  refreshTokenExpiresAt?: Date | undefined;
  ApplicationId: number;
  UserId: number;
  data: Record<string, unknown>;
}

// Define all attributes for the model
interface UserTokenAttributes extends UserTokenCreateAttributes, OAuth2Server.Token {
  id: number;
  // Standard temporal fields
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export enum TokenType {
  OAUTH = 'OAUTH',
}
class UserToken extends Model<UserTokenAttributes, UserTokenCreateAttributes> implements UserTokenAttributes {
  public declare id: number;
  public declare type: 'OAUTH';
  public declare accessToken: string;
  public declare accessTokenExpiresAt: Date;
  public declare refreshToken: string;
  public declare refreshTokenExpiresAt?: Date;
  public declare ApplicationId: number;
  public declare UserId: number;
  public declare data: Record<string, unknown>;
  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt?: Date;
  public declare user: typeof models.User;
  public declare client: typeof models.Application;
}

UserToken.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      type: DataTypes.ENUM('OAUTH'),
      allowNull: false,
    },
    accessToken: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    accessTokenExpiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    refreshToken: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    refreshTokenExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    ApplicationId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Applications' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      allowNull: false,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    // Standard temporal fields
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
    tableName: 'UserTokens',
    paranoid: true, // For soft-deletion
    defaultScope: {
      include: [
        { association: 'user', required: true },
        { association: 'client', required: true },
      ],
    },
  },
);

export default UserToken;
