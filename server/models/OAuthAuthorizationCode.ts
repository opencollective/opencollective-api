import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import oAuthScopes from '../constants/oauth-scopes';
import sequelize, { DataTypes } from '../lib/sequelize';

import Application from './Application';
import { ModelWithPublicId } from './ModelWithPublicId';
import User from './User';

class OAuthAuthorizationCode extends ModelWithPublicId<
  InferAttributes<OAuthAuthorizationCode>,
  InferCreationAttributes<OAuthAuthorizationCode>
> {
  public static readonly nanoIdPrefix = 'oacode' as const;
  public static readonly tableName = 'OAuthAuthorizationCodes' as const;

  declare public readonly id: CreationOptional<number>;
  declare public readonly publicId: string;
  declare public code: string;
  declare public redirectUri: string;
  declare public expiresAt: Date;
  declare public data: Record<string, unknown>;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
  declare public ApplicationId: number;
  declare public UserId: ForeignKey<User['id']>;
  declare public scope: string[];
  declare public codeChallenge: CreationOptional<string>;
  declare public codeChallengeMethod: CreationOptional<string>;

  declare public application?: NonAttribute<Application>;
  declare public user?: NonAttribute<User>;
}

OAuthAuthorizationCode.init(
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
    code: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    redirectUri: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
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
    scope: {
      type: DataTypes.ARRAY(DataTypes.ENUM(...Object.values(oAuthScopes))),
      allowNull: true,
    },
    codeChallenge: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    codeChallengeMethod: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'OAuthAuthorizationCodes',
    paranoid: true, // For soft-deletion
  },
);

export default OAuthAuthorizationCode;
