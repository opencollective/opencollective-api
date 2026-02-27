import type OAuth2Server from '@node-oauth/oauth2-server';
import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import oAuthScopes from '../constants/oauth-scopes';
import sequelize, { DataTypes } from '../lib/sequelize';

import Application from './Application';
import { ModelWithPublicId } from './ModelWithPublicId';
import User from './User';

export enum TokenType {
  OAUTH = 'OAUTH',
}

class UserToken extends ModelWithPublicId<InferAttributes<UserToken>, InferCreationAttributes<UserToken>> {
  public static readonly nanoIdPrefix = 'utok' as const;
  public static readonly tableName = 'UserTokens' as const;

  declare public id: CreationOptional<number>;
  declare public readonly publicId: string;
  declare public type: 'OAUTH';
  declare public accessToken: string;
  declare public accessTokenExpiresAt: Date;
  declare public refreshToken: string;
  declare public refreshTokenExpiresAt?: Date;
  declare public ApplicationId: number;
  declare public UserId: ForeignKey<User['id']>;
  declare public data: Record<string, unknown>;
  declare public scope: string[];
  declare public preAuthorize2FA: boolean;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
  declare public lastUsedAt: CreationOptional<Date>;

  declare public user?: NonAttribute<User>;
  declare public application?: NonAttribute<Application>;

  declare public client?: NonAttribute<OAuth2Server.Client>;

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
    publicId: {
      type: DataTypes.STRING,
      unique: true,
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
    preAuthorize2FA: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
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
        { association: 'application', required: true },
      ],
    },
  },
);

export default UserToken;
