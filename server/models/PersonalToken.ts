import { randomBytes } from 'crypto';

import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import oAuthScopes from '../constants/oauth-scopes';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Application from './Application';
import User from './User';

class PersonalToken extends Model<InferAttributes<PersonalToken>, InferCreationAttributes<PersonalToken>> {
  declare public readonly id: CreationOptional<number>;
  declare public token: string;
  declare public expiresAt: Date;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
  declare public lastUsedAt: CreationOptional<Date>;
  declare public data: Record<string, unknown>;
  declare public CollectiveId: number;
  declare public UserId: ForeignKey<User['id']>;
  declare public scope: oAuthScopes[];
  declare public name: string;
  declare public preAuthorize2FA: CreationOptional<boolean>;

  declare public application?: NonAttribute<typeof Application>;
  declare public user?: NonAttribute<typeof User>;

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
    preAuthorize2FA: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
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
