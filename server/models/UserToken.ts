import type { CreationOptional, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import models from '.';

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
  public declare UserId: number;
  public declare data: Record<string, unknown>;
  public declare scope: string;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;

  public declare user?: NonAttribute<typeof models.User>;
  public declare client?: NonAttribute<typeof models.Application>;

  getScope() {
    if (typeof this.scope === 'string') {
      return this.scope.split(',');
    }

    return this.scope;
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
      type: DataTypes.STRING,
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
