import type { BelongsToGetAssociationMixin, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';
import { z } from 'zod';

import { formatZodError } from '../lib/errors';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';
import UploadedFile from './UploadedFile';
import User from './User';

// For some reason `CreationOptional` is not enough to make fields optional
type CreationAttributes = InferCreationAttributes<
  ExportRequest,
  {
    omit: 'id' | 'data' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'expiresAt' | 'UploadedFileId';
  }
>;

export enum ExportRequestTypes {
  TRANSACTIONS = 'TRANSACTIONS',
  HOSTED_COLLECTIVES = 'HOSTED_COLLECTIVES',
}

export enum ExportRequestStatus {
  ENQUEUED = 'ENQUEUED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

const dataSchema = z
  .object({
    progress: z.number().min(0).max(100).optional(),
    error: z.string().optional(),
    rowCount: z.number().optional(),
    retryCount: z.number().optional(),
    lastAttemptAt: z.string().optional(),
    shouldRetry: z.boolean().optional(),
    shouldNotify: z.boolean().optional(),
  })
  .optional();

type ExportRequestData = z.infer<typeof dataSchema>;

class ExportRequest extends Model<InferAttributes<ExportRequest>, CreationAttributes> {
  public static readonly tableName = 'ExportRequests' as const;

  declare public id: number;
  declare public CollectiveId: ForeignKey<Collective['id']>;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public UploadedFileId: ForeignKey<UploadedFile['id']>;
  declare public name: string;
  declare public type: ExportRequestTypes;
  declare public parameters: Record<string, unknown> | null;
  declare public status: ExportRequestStatus;
  declare public data: ExportRequestData | null;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt: Date;
  declare public expiresAt: Date;

  declare public collective?: Collective;
  declare public getCollective: BelongsToGetAssociationMixin<Collective>;
  declare public createdByUser?: User;
  declare public getCreatedByUser: BelongsToGetAssociationMixin<User>;
  declare public uploadedFile?: UploadedFile;
  declare public getUploadedFile: BelongsToGetAssociationMixin<UploadedFile>;

  async fail(error: string, options?: { shouldRetry?: boolean }): Promise<void> {
    const newData: ExportRequest['data'] = Object.assign({}, this.data, {
      lastAttemptAt: new Date().toISOString(),
      shouldRetry: options?.shouldRetry || false,
      retryCount: (this.data?.retryCount || 0) + 1,
      error,
    });
    await this.update({ status: ExportRequestStatus.FAILED, data: newData });
  }
}

ExportRequest.init(
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    // One-to-one relationship enforced by a unique index constraint.
    UploadedFileId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'UploadedFiles' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true,
        isIn: {
          args: [Object.values(ExportRequestTypes)],
          msg: `Export request type must be one of ${Object.values(ExportRequestTypes).join(', ')}`,
        },
      },
    },
    parameters: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
    },
    status: {
      type: DataTypes.ENUM(...Object.values(ExportRequestStatus)),
      allowNull: false,
      defaultValue: ExportRequestStatus.ENQUEUED,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      validate: {
        isValid(value) {
          const result = dataSchema.safeParse(value);
          if (!result.success) {
            throw new Error(`Invalid export request data:\n${formatZodError(result.error)}`);
          }
        },
      },
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'ExportRequests',
    paranoid: true, // For soft-deletion
    timestamps: true,
  },
);

export default ExportRequest;
