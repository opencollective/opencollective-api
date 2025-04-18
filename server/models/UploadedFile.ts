import path from 'path';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { encode } from 'blurhash';
import config from 'config';
import type { FileUpload as GraphQLFileUpload } from 'graphql-upload/Upload.js';
import { isEmpty, kebabCase } from 'lodash';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
} from 'sequelize';
import sharp from 'sharp';
import { v4 as uuid } from 'uuid';

import { FileKind, SUPPORTED_FILE_KINDS } from '../constants/file-kind';
import { idDecode, idEncode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import { checkS3Configured, uploadToS3 } from '../lib/awsS3';
import logger from '../lib/logger';
import { ExpenseOCRParseResult, ExpenseOCRService } from '../lib/ocr/ExpenseOCRService';
import RateLimit from '../lib/rate-limit';
import { reportErrorToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Model } from '../lib/sequelize';
import streamToBuffer from '../lib/stream-to-buffer';
import { isValidURL } from '../lib/url-utils';

import User from './User';

// Types
type SUPPORTED_FILE_TYPES_UNION = (typeof SUPPORTED_FILE_TYPES)[number];

type CommonDataShape = {
  /** A unique identified to record what part of the code uploaded this image. By convention, the default upload function doesn't set this */
  recordedFrom?: string;
  completedAt?: string;
  /** A checksum of the content as returned by Amazon S3 (cannot be computed locally since we use server-side encryption) */
  s3SHA256?: string;
  mutationStartDate?: string;
  uploadStartDate?: string;
  uploadDuration?: number; // in seconds
  ocrData?: {
    type: 'Expense';
    parser: ExpenseOCRService['PARSER_ID'];
    result: ExpenseOCRParseResult;
    executionTime: number; // in seconds
  };
};

type ImageDataShape = CommonDataShape & {
  width: number;
  height: number;
  blurHash: string;
};

type FileUpload = {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
};

// Constants

const MAX_FILENAME_LENGTH = 1024; // From S3
export const MAX_UPLOADED_FILE_URL_LENGTH = 1200; // From S3
const MAX_FILE_SIZE = 1024 * 1024 * 10; // 10MB
export const SUPPORTED_FILE_TYPES_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const SUPPORTED_FILE_TYPES = [...SUPPORTED_FILE_TYPES_IMAGES, 'application/pdf', 'text/csv'] as const;
type SupportedFileType = (typeof SUPPORTED_FILE_TYPES)[number];
export const SUPPORTED_FILE_EXTENSIONS: Record<SUPPORTED_FILE_TYPES_UNION, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/csv': '.csv',
} as const;

const SupportedTypeByKind: Record<FileKind, readonly SupportedFileType[]> = {
  ACCOUNT_AVATAR: SUPPORTED_FILE_TYPES_IMAGES,
  ACCOUNT_BANNER: SUPPORTED_FILE_TYPES_IMAGES,
  EXPENSE_ATTACHED_FILE: SUPPORTED_FILE_TYPES,
  EXPENSE_ITEM: SUPPORTED_FILE_TYPES,
  EXPENSE_INVOICE: SUPPORTED_FILE_TYPES,
  TRANSACTIONS_IMPORT: ['text/csv'],
  ACCOUNT_LONG_DESCRIPTION: SUPPORTED_FILE_TYPES_IMAGES,
  UPDATE: SUPPORTED_FILE_TYPES_IMAGES,
  COMMENT: SUPPORTED_FILE_TYPES_IMAGES,
  TIER_LONG_DESCRIPTION: SUPPORTED_FILE_TYPES_IMAGES,
  ACCOUNT_CUSTOM_EMAIL: SUPPORTED_FILE_TYPES_IMAGES,
  AGREEMENT_ATTACHMENT: SUPPORTED_FILE_TYPES,
} as const;

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
  declare data: CreationOptional<null | CommonDataShape | ImageDataShape>;
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
    if (UploadedFile.isOpenCollectiveProtectedS3BucketURL(url)) {
      return true;
    }

    if (!url) {
      return false;
    }

    let parsedURL: URL;
    try {
      parsedURL = new URL(url);
    } catch {
      return false;
    }

    const endpoint = config.aws.s3.endpoint || `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com`;
    const searchParams = parsedURL.searchParams;
    searchParams.delete('draftKey');
    searchParams.delete('expenseId');
    return (
      parsedURL.origin === endpoint &&
      /\/\w+/.test(parsedURL.pathname) &&
      searchParams.size === 0 &&
      isEmpty(parsedURL.hash) &&
      isEmpty(parsedURL.username) &&
      isEmpty(parsedURL.password)
    );
  }

  public static isOpenCollectiveProtectedS3BucketURL(url: string): boolean {
    if (!url) {
      return false;
    }

    let parsedURL: URL;
    try {
      parsedURL = new URL(url);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      return false;
    }

    return parsedURL.origin === config.host.website && /^\/api\/files\/[^\/]+\/?$/.test(parsedURL.pathname);
  }

  public static getFromProtectedURL(url: string): Promise<UploadedFile> {
    if (!UploadedFile.isOpenCollectiveProtectedS3BucketURL(url)) {
      return null;
    }

    let parsedURL: URL;
    try {
      parsedURL = new URL(url);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      return null;
    }

    const match = parsedURL.pathname.match(/^\/api\/files\/([^\/]+)\/?$/);

    if (match?.length !== 2) {
      return null;
    }

    const encodedId = match[1];

    return UploadedFile.findByPk(idDecode(encodedId, IDENTIFIER_TYPES.UPLOADED_FILE));
  }

  public static getProtectedURLFromOpenCollectiveS3Bucket(
    uploadedFile: UploadedFile,
    options?: { expenseId: number; draftKey: string },
  ): string {
    const url = new URL(
      `${config.host.website}/api/files/${idEncode(uploadedFile.id, IDENTIFIER_TYPES.UPLOADED_FILE)}`,
    );

    if (options?.expenseId) {
      url.searchParams.set('expenseId', idEncode(options.expenseId, IDENTIFIER_TYPES.EXPENSE));

      if (options?.draftKey) {
        url.searchParams.set('draftKey', options.draftKey);
      }
    }

    return url.toString();
  }

  public static isUploadedFileURL(url: string): boolean {
    return UploadedFile.isOpenCollectiveProtectedS3BucketURL(url) || UploadedFile.isOpenCollectiveS3BucketURL(url);
  }

  public static getFromURL(url: string): Promise<UploadedFile> {
    if (!UploadedFile.isUploadedFileURL(url)) {
      return null;
    }

    if (UploadedFile.isOpenCollectiveProtectedS3BucketURL(url)) {
      return UploadedFile.getFromProtectedURL(url);
    }
    return UploadedFile.findOne({
      where: {
        url,
      },
    });
  }

  public static isSupportedImageMimeType(mimeType: string): boolean {
    return (SUPPORTED_FILE_TYPES_IMAGES as readonly string[]).includes(mimeType);
  }

  public static isSupportedMimeType(mimeType: string): boolean {
    return (SUPPORTED_FILE_TYPES as readonly string[]).includes(mimeType);
  }

  /**
   * Returns the rate limiter for uploading files.
   * Currently set to 100 files/user/hour.
   */
  public static getUploadRateLimiter(user: User): RateLimit {
    return new RateLimit(`uploadFile-${user.id}`, 100, 60 * 60);
  }

  public static async getFileUploadFromGraphQLUpload(file: GraphQLFileUpload): Promise<FileUpload> {
    const buffer = await streamToBuffer(file.createReadStream());
    return {
      buffer,
      size: buffer.length,
      mimetype: file.mimetype,
      originalname: file.filename,
    };
  }

  public static async uploadGraphQl(file: GraphQLFileUpload, kind: FileKind, user: User | null): Promise<UploadedFile> {
    if (!kind || !SupportedTypeByKind[kind]) {
      throw new Error('Invalid file kind');
    }

    const fileUpload = await UploadedFile.getFileUploadFromGraphQLUpload(file);
    return UploadedFile.upload(fileUpload, kind, user);
  }

  public static validateFile(
    file: FileUpload,
    supported: readonly SupportedFileType[] = SUPPORTED_FILE_TYPES,
    ErrorClass: new (msg: string, ...additionalParams: unknown[]) => Error = Error,
  ): void {
    if (!file) {
      throw new ErrorClass('File is required');
    } else if (!(supported as readonly string[]).includes(file.mimetype)) {
      throw new ErrorClass(`Mimetype of the file should be one of: ${supported.join(', ')}`);
    } else if (file.size > MAX_FILE_SIZE) {
      throw new ErrorClass(`File size cannot exceed ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    } else if (!file.size) {
      throw new ErrorClass('File is empty');
    }
  }

  public static async upload(
    file: FileUpload,
    kind: FileKind,
    user: User | null,
    args: {
      fileName?: string;
    } = {},
  ): Promise<UploadedFile> {
    // Validate file
    UploadedFile.validateFile(file, SupportedTypeByKind[kind]);

    // Should only happen in dev/test envs
    if (!checkS3Configured()) {
      logger.error('No S3 client available');
      throw new Error('There was a problem while uploading the file');
    }

    // Strip EXIF data from images
    if (UploadedFile.isSupportedImageMimeType(file.mimetype)) {
      try {
        const image = sharp(file.buffer);
        file.buffer = await image
          .rotate() // Auto-rotate based on EXIF Orientation tag
          .toBuffer(); // The default behaviour, when withMetadata is not used, is to strip all metadata and convert to the device-independent sRGB colour space
        file.size = file.buffer.length;
      } catch (e) {
        reportErrorToSentry(e, { user });
        throw new Error('The image is corrupted');
      }
    }

    /**
     * We will replace the name to avoid collisions
     */
    const fileName = UploadedFile.getFilename(file, args.fileName);
    const uploadParams: PutObjectCommand['input'] = {
      Bucket: config.aws.s3.bucket,
      Key: `${kebabCase(kind)}/${uuid()}/${fileName || uuid()}`,
      Body: file.buffer,
      ACL: 'public-read', // We're aware of the security implications of this and will be looking for a better solution in https://github.com/opencollective/opencollective/issues/6351
      ContentLength: file.size,
      ContentType: file.mimetype,
      // Adding the checksum for S3 to validate the integrity of the file
      // See https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html#API_PutObject_RequestSyntax
      ChecksumAlgorithm: 'SHA256',
      // Custom S3 metadata
      Metadata: {
        CreatedByUserId: `${user?.id}`,
        FileKind: kind,
      },
    };

    try {
      const uploadResult = await uploadToS3(uploadParams);
      return UploadedFile.create({
        kind: kind,
        fileName,
        fileSize: file.size,
        fileType: file.mimetype as (typeof SUPPORTED_FILE_TYPES)[number],
        url: uploadResult.url,
        data: await UploadedFile.getData(file, uploadResult.s3Data?.ChecksumSHA256),
        CreatedByUserId: user?.id,
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

  private static async getData(file, s3SHA256: string = null) {
    if (UploadedFile.isSupportedImageMimeType(file.mimetype)) {
      const image = sharp(file.buffer);
      const { width, height } = await image.metadata();

      let blurHash;
      try {
        const { data, info } = await image
          .raw()
          .ensureAlpha()
          .resize({ fit: sharp.fit.contain, width: 200 })
          .toBuffer({ resolveWithObject: true });
        blurHash = encode(Uint8ClampedArray.from(data), info.width, info.height, 4, 4);
      } catch (err) {
        reportErrorToSentry(err, {
          severity: 'error',
        });
      }

      return { width, height, blurHash, s3SHA256 };
    } else {
      return { s3SHA256 };
    }
  }

  private static getFilename(file: FileUpload, fileNameFromArgs: string | null) {
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
      set(fileName: string | null): void {
        this.setDataValue('fileName', fileName || null);
      },
      validate: {
        notEmpty: true,
        len: {
          args: [1, MAX_FILENAME_LENGTH],
          msg: `File name cannot exceed ${MAX_FILENAME_LENGTH} characters`,
        },
        hasExtension: (fileName: string): void => {
          if (fileName && !path.extname(fileName)) {
            throw new Error('File name must have an extension');
          }
        },
      },
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
      get() {
        const url = this.getDataValue('url');
        const kind = this.getDataValue('kind');
        if (
          ['EXPENSE_ITEM', 'EXPENSE_ATTACHED_FILE', 'EXPENSE_INVOICE'].includes(kind) &&
          UploadedFile.isOpenCollectiveS3BucketURL(url)
        ) {
          return UploadedFile.getProtectedURLFromOpenCollectiveS3Bucket(this);
        } else {
          return url;
        }
      },
      validate: {
        notNull: true,
        notEmpty: true,
        len: {
          args: [0, MAX_UPLOADED_FILE_URL_LENGTH],
          msg: 'The uploaded file URL is too long',
        },
        isValidURL(url: string): void {
          if (!isValidURL(url)) {
            throw new Error('File URL is not a valid URL');
          }

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
