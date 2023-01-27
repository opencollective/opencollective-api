import type OAuth2Server from '@node-oauth/oauth2-server';
import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import oAuthScopes from '../constants/oauth-scopes';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import User from './User';
// import models from '.';

export enum TokenType {
  OAUTH = 'OAUTH',
}

class UserToken extends Model<InferAttributes<UserToken>, InferCreationAttributes<UserToken>> {
  public declare id: CreationOptional<number>;
  public declare type: 'OAUTH';
  public declare accessToken: string;
  public declare accessTokenExpiresAt: Date;
  public declare refreshToken: string;
  public declare refreshTokenExpiresAt?: Date;
  public declare ApplicationId: number;
  public declare UserId: ForeignKey<User['id']>;
  public declare data: Record<string, unknown>;
  public declare scope: string[];
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare lastUsedAt: CreationOptional<Date>;

  public declare user?: NonAttribute<User>;
  public declare client?: NonAttribute<OAuth2Server.Client>;

  hasScope(scope): boolean {
    return Boolean(this.scope && this.scope.includes(scope));
  }
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
    scope: {
      type: DataTypes.ARRAY(DataTypes.ENUM(...Object.values(oAuthScopes))),
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
    lastUsedAt: {
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
