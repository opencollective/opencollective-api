import path from 'path';

import { encode } from 'blurhash';
import config from 'config';
import { kebabCase } from 'lodash';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
} from 'sequelize';
import sharp from 'sharp';
import { v4 as uuid } from 'uuid';

import s3, { uploadToS3 } from '../lib/awsS3';
import logger from '../lib/logger';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Model } from '../lib/sequelize';
import { MulterFile } from '../types/Multer';

import User from './User';

// Types
type SUPPORTED_FILE_TYPES_UNION = (typeof SUPPORTED_FILE_TYPES)[number];

type ImageDataShape = {
  width: number;
  height: number;
  blurHash: string;
};

// Constants
export const MAX_FILE_SIZE = 1024 * 1024 * 10; // 10MB
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

export type FileKind = (typeof SUPPORTED_FILE_KINDS)[number];

/**
 * A file uploaded to our S3 bucket.
 */
class UploadedFile extends Model<InferAttributes<UploadedFile>, InferCreationAttributes<UploadedFile>> {
  declare id: CreationOptional<number>;
  declare kind: CreationOptional<FileKind>;
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
  public static isOpenCollectiveS3BucketURL(url: string): boolean {
    return new RegExp(`^https://${config.aws.s3.bucket}\\.s3[.-]us-west-1.amazonaws.com/\\w+`).test(url);
  }

  public static isSupportedImageMimeType(mimeType: string): boolean {
    return (SUPPORTED_FILE_TYPES_IMAGES as readonly string[]).includes(mimeType);
  }

  public static isSupportedMimeType(mimeType: string): boolean {
    return (SUPPORTED_FILE_TYPES as readonly string[]).includes(mimeType);
  }

  public static async upload(
    file: MulterFile,
    kind: FileKind,
    user: User | null,
    args: { fileName?: string } = {},
  ): Promise<UploadedFile> {
    // Validate file
    if (!file) {
      throw new Error('File is required');
    } else if (!(SUPPORTED_FILE_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new Error(`Mimetype of the file should be one of: ${SUPPORTED_FILE_TYPES.join(', ')}`);
    } else if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File size cannot exceed ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }

    // Should only happen in dev/test envs
    if (!s3) {
      logger.error('No S3 client available');
      throw new Error('There was a problem while uploading the file');
    }

    /**
     * We will replace the name to avoid collisions
     */
    const fileName = UploadedFile.getFilename(file, args.fileName);
    const uploadParams = {
      Bucket: config.aws.s3.bucket,
      Key: `${kebabCase(kind)}/${uuid()}/${fileName || uuid()}`,
      Body: file.buffer,
      ACL: 'public-read', // We're aware of the security implications of this and will be looking for a better solution in https://github.com/opencollective/opencollective/issues/6351
      ContentLength: file.size,
      ContentType: file.mimetype,
      Metadata: {
        CreatedByUserId: `${user?.id}`,
        FileKind: kind,
      },
    };

    try {
      const s3Data = await uploadToS3(uploadParams);
      return UploadedFile.create({
        kind: kind,
        fileName,
        fileSize: file.size,
        fileType: file.mimetype as (typeof SUPPORTED_FILE_TYPES)[number],
        url: s3Data.Location,
        data: await UploadedFile.getData(file),
        CreatedByUserId: user.id,
      });
    } catch (err) {
      reportErrorToSentry(err, {
        severity: 'error',
        extra: { kind, fileName, fileType: file.mimetype },
        user,
      });

      throw new Error('There was a problem while uploading the file');
    }
  }

  private static async getData(file) {
    if (UploadedFile.isSupportedImageMimeType(file.mimetype)) {
      const image = sharp(file.buffer);
      const { width, height } = await image.metadata();
      const { data, info } = await image
        .raw()
        .ensureAlpha()
        .resize({ fit: sharp.fit.contain, width: 200 })
        .toBuffer({ resolveWithObject: true });
      const blurHash = encode(data, info.width, info.height, 4, 4);
      return { width, height, blurHash };
    } else {
      return null;
    }
  }

  private static getFilename(file: MulterFile, fileNameFromArgs: string | null) {
    const expectedExtension = SUPPORTED_FILE_EXTENSIONS[file.mimetype];
    const rawFileName = fileNameFromArgs || file.originalname || uuid();
    const parsedFileName = path.parse(rawFileName);
    // S3 limits file names to 1024 characters. We're using 900 to be safe and give some room for the kind + uuid + extension.
    return `${parsedFileName.name.slice(0, 900)}${expectedExtension}`;
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
