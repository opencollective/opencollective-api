import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import models from '.';

// Define attributes that can be used for model creation
interface OAuthAuthorizationCodeCreateAttributes {
  code: string;
  redirectUri: string;
  expiresAt: Date;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  ApplicationId: number;
  UserId: number;
}

// Define all attributes for the model
interface OAuthAuthorizationCodeAttributes extends OAuthAuthorizationCodeCreateAttributes {
  id: number;
}

class OAuthAuthorizationCode
  extends Model<OAuthAuthorizationCodeAttributes, OAuthAuthorizationCodeCreateAttributes>
  implements OAuthAuthorizationCodeAttributes
{
  id: number;
  code: string;
  redirectUri: string;
  expiresAt: Date;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  ApplicationId: number;
  UserId: number;
  application: typeof models.Application;
  user: typeof models.User;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }
}

OAuthAuthorizationCode.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
  },
  {
    sequelize,
    tableName: 'OAuthAuthorizationCodes',
    paranoid: true, // For soft-deletion
  },
);

export default OAuthAuthorizationCode;
