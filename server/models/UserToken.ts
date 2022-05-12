import crypto from 'crypto';

import config from 'config';
import moment from 'moment';

import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

// Define all attributes for the model
interface UserTokenAttributes {
  id: number;
  type: 'OAUTH';
  token: string;
  expiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt?: Date;
  ApplicationId: number;
  UserId: number;
  data: Record<string, unknown>;
  // Standard temporal fields
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

// Define attributes that can be used for model creation
interface UserTokenCreateAttributes {
  type: 'OAUTH';
  token: string;
  expiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt?: Date;
  ApplicationId: number;
  UserId: number;
  data: Record<string, unknown>;
}

const TOKEN_LENGTH = 64;
const OAUTH_TOKEN_EXPIRATION_DAYS = 60;
const OAUTH_REFRESH_TOKEN_EXPIRATION_DAYS = 360;

export enum TokenType {
  OAUTH = 'OAUTH',
}

class UserToken extends Model<UserTokenAttributes, UserTokenCreateAttributes> implements UserTokenAttributes {
  id: number;
  type: 'OAUTH';
  token: string;
  expiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt?: Date;
  ApplicationId: number;
  UserId: number;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

  /**
   * Generate a user token for an OAuth application
   */
  public static generateOAuth(
    UserId: number,
    ApplicationId: number,
    data: Record<string, unknown> = null,
  ): Promise<UserToken> {
    return UserToken.create({
      type: TokenType.OAUTH,
      UserId,
      ApplicationId,
      token: UserToken.generateToken(TokenType.OAUTH),
      refreshToken: UserToken.generateToken(TokenType.OAUTH),
      expiresAt: moment().add(OAUTH_TOKEN_EXPIRATION_DAYS, 'days').toDate(),
      refreshTokenExpiresAt: moment().add(OAUTH_REFRESH_TOKEN_EXPIRATION_DAYS, 'days').toDate(),
      data,
    });
  }

  // TODO: We're moving this to server/lib/oauth/model.ts
  private static generateToken(type: TokenType): string {
    if (type === TokenType.OAUTH) {
      const prefix = config.env === 'production' ? 'oauth_' : 'test_oauth_';
      return `${prefix}_${crypto.randomBytes(64).toString('hex')}`.slice(0, TOKEN_LENGTH);
    } else {
      throw new Error(`Unknown token type: ${type}`);
    }
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
    token: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    expiresAt: {
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
  },
);

export default UserToken;
