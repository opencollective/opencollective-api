import config from 'config';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
} from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import User from './User';

// Types
type SUPPORTED_FILE_TYPES_UNION = (typeof SUPPORTED_FILE_TYPES)[number];

type ImageDataShape = {
  width: number;
  height: number;
  blurHash: string;
};

// Constants
export const SUPPORTED_FILE_TYPES_IMAGES = ['image/png', 'image/jpeg', 'image/gif'] as const;
export const SUPPORTED_FILE_TYPES = [...SUPPORTED_FILE_TYPES_IMAGES, 'application/pdf'] as const;
export const SUPPORTED_FILE_EXTENSIONS: Record<SUPPORTED_FILE_TYPES_UNION, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
} as const;
export const SUPPORTED_FILE_KINDS = [
  // Base fields
  'ACCOUNT_AVATAR',
  'ACCOUNT_BANNER',
  'EXPENSE_ATTACHED_FILE',
  'EXPENSE_ITEM',
  // Rich text fields
  'ACCOUNT_LONG_DESCRIPTION',
  'UPDATE',
  'COMMENT',
  'TIER_LONG_DESCRIPTION',
  'ACCOUNT_CUSTOM_EMAIL',
] as const;

/**
 * A file uploaded to our S3 bucket.
 */
class UploadedFile extends Model<InferAttributes<UploadedFile>, InferCreationAttributes<UploadedFile>> {
  declare id: CreationOptional<number>;
  declare kind: CreationOptional<(typeof SUPPORTED_FILE_KINDS)[number]>;
  declare fileName: CreationOptional<string>;
  declare fileSize: CreationOptional<number>; // In bytes
  declare fileType: CreationOptional<SUPPORTED_FILE_TYPES_UNION>;
  declare url: string;
  declare data: CreationOptional<ImageDataShape>;
  // Temporal fields
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;
  // Relationships
  declare CreatedByUserId: ForeignKey<User['id']>;

  // Association methods
  declare getCreatedByUser: BelongsToGetAssociationMixin<User>;

  // ==== Static methods ====
  static isOpenCollectiveS3BucketURL(url: string): boolean {
    return new RegExp(`^https://${config.aws.s3.bucket}\\.s3[.-]us-west-1.amazonaws.com/\\w+`).test(url);
  }
}

UploadedFile.init(
  {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER,
    },
    kind: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notNull: true,
        notEmpty: true,
        isIn: [SUPPORTED_FILE_KINDS],
      },
    },
    fileName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    fileSize: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        isNumeric: true,
        min: 0,
        // No max here as its defined when uploading, this is only for reference
      },
    },
    fileType: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notNull: true,
        notEmpty: true,
        isIn: [SUPPORTED_FILE_TYPES],
      },
    },
    url: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        notNull: true,
        notEmpty: true,
        isUrl: true,
        isValidURL(url: string): void {
          if (!UploadedFile.isOpenCollectiveS3BucketURL(url)) {
            throw new Error('File URL is not valid');
          }
        },
      },
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    createdAt: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      allowNull: true,
      type: DataTypes.DATE,
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      allowNull: true,
      onDelete: 'SET NULL',
      onUpdate: 'SET NULL',
    },
  },
  {
    sequelize,
    tableName: 'UploadedFiles',
    paranoid: true, // For soft-deletion
  },
);

export default UploadedFile;
