import { randomBytes } from 'crypto';

import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import oAuthScopes from '../constants/oauth-scopes.js';
import sequelize, { DataTypes, Model } from '../lib/sequelize.js';

import User from './User.js';
import models from './index.js';

class PersonalToken extends Model<InferAttributes<PersonalToken>, InferCreationAttributes<PersonalToken>> {
  public declare readonly id: CreationOptional<number>;
  public declare token: string;
  public declare expiresAt: Date;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare lastUsedAt: CreationOptional<Date>;
  public declare data: Record<string, unknown>;
  public declare CollectiveId: number;
  public declare UserId: ForeignKey<User['id']>;
  public declare scope: oAuthScopes[];
  public declare name: string;

  public declare application?: NonAttribute<typeof models.Application>;
  public declare user?: NonAttribute<typeof models.User>;

  public static generateToken(): string {
    return randomBytes(20).toString('hex');
  }

  hasScope(scope): boolean {
    return Boolean(this.scope && this.scope.includes(scope));
  }
}

PersonalToken.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    token: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
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
    scope: {
      type: DataTypes.ARRAY(DataTypes.ENUM(...Object.values(oAuthScopes))),
      allowNull: true,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
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
    lastUsedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'PersonalTokens',
    paranoid: true,
  },
);

export default PersonalToken;
