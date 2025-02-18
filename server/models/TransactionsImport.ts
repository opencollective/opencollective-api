import { mapValues, omit, uniq } from 'lodash';
import { AccountSubtype, AccountType } from 'plaid';
import type {
  BelongsToGetAssociationMixin,
  ForeignKey,
  HasManyCreateAssociationMixin,
  HasManyGetAssociationsMixin,
  InferAttributes,
  InferCreationAttributes,
  Transaction as SequelizeTransaction,
} from 'sequelize';
import { z } from 'zod';

import ActivityTypes from '../constants/activities';
import { formatZodError } from '../lib/errors';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Activity from './Activity';
import Collective from './Collective';
import ConnectedAccount from './ConnectedAccount';
import TransactionsImportRow from './TransactionsImportRow';
import UploadedFile from './UploadedFile';
import User from './User';

// For some reason `CreationOptional` is not enough to make fields optional
type CreationAttributes = InferCreationAttributes<
  TransactionsImport,
  {
    omit:
      | 'id'
      | 'settings'
      | 'data'
      | 'lastSyncAt'
      | 'createdAt'
      | 'updatedAt'
      | 'deletedAt'
      | 'UploadedFileId'
      | 'ConnectedAccountId';
  }
>;

export const TransactionsImportTypes = ['CSV', 'MANUAL', 'PLAID'] as const;

const settingsSchema = z
  .object({
    assignments: z.record(z.string(), z.array(z.number())).optional(),
    csvConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

type TransactionsImportSettings = z.infer<typeof settingsSchema>;

const dataSchema = z
  .object({
    lockedAt: z.string().optional(),
    plaid: z
      .object({
        lastSyncCursor: z.string().optional(),
        syncAttempt: z.number().optional(),
        lastSyncErrorMessage: z.string().optional(),
        availableAccounts: z
          .array(
            z.object({
              accountId: z.string(),
              mask: z.string(),
              name: z.string(),
              officialName: z.string(),
              subtype: z.nativeEnum(AccountSubtype),
              type: z.nativeEnum(AccountType),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .optional();

type TransactionsImportData = z.infer<typeof dataSchema>;

// A custom error type for when a transaction import is locked
export class TransactionsImportLockedError extends Error {
  constructor() {
    super('This import is already locked');
    this.name = 'TransactionsImportLockedError';
  }
}

class TransactionsImport extends Model<InferAttributes<TransactionsImport>, CreationAttributes> {
  declare public id: number;
  declare public CollectiveId: ForeignKey<Collective['id']>;
  declare public UploadedFileId: ForeignKey<UploadedFile['id']>;
  declare public ConnectedAccountId: ForeignKey<ConnectedAccount['id']>;
  declare public source: string;
  declare public name: string;
  declare public type: (typeof TransactionsImportTypes)[number];
  declare public settings: TransactionsImportSettings | null;
  declare public data: TransactionsImportData | null;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt: Date;
  declare public lastSyncAt: Date;

  declare public collective?: Collective;
  declare public getCollective: BelongsToGetAssociationMixin<Collective>;
  declare public importRows?: TransactionsImportRow[];
  declare public getImportRows: HasManyGetAssociationsMixin<TransactionsImportRow>;
  declare public createImportRow: HasManyCreateAssociationMixin<TransactionsImportRow>;
  declare public getConnectedAccount: BelongsToGetAssociationMixin<ConnectedAccount>;

  static async createWithActivity(
    remoteUser: User,
    collective: Collective,
    attributes: Omit<Parameters<typeof TransactionsImport.create>[0], 'CollectiveId'>,
    { UserTokenId, transaction }: { UserTokenId?: number; transaction?: SequelizeTransaction } = {},
  ): Promise<TransactionsImport> {
    const runWithTransaction = async transaction => {
      const importInstance = await TransactionsImport.create(
        {
          ...attributes,
          CollectiveId: collective.id,
        },
        { transaction },
      );
      await Activity.create({
        type: ActivityTypes.TRANSACTIONS_IMPORT_CREATED,
        CollectiveId: importInstance.CollectiveId,
        FromCollectiveId: remoteUser.CollectiveId,
        HostCollectiveId: collective.HostCollectiveId,
        UserId: remoteUser.id,
        UserTokenId,
        data: { TransactionsImportId: importInstance.id },
      });

      return importInstance;
    };

    if (transaction) {
      return runWithTransaction(transaction);
    } else {
      return sequelize.transaction(runWithTransaction);
    }
  }

  async addRows(data, { transaction = undefined } = {}) {
    return TransactionsImportRow.bulkCreate(
      data.map(row => ({ ...row, TransactionsImportId: this.id })),
      { transaction },
    );
  }

  /**
   * Locks the import to prevent it from being modified by other processes.
   */
  async lock<T = void>(callback: (importInstance: TransactionsImport) => Promise<T>): Promise<T> {
    // Lock
    try {
      await sequelize.transaction(async sqlTransaction => {
        await this.reload({ transaction: sqlTransaction, lock: true });
        if (this.data?.lockedAt) {
          throw new TransactionsImportLockedError();
        } else {
          await this.update(
            { data: { ...this.data, lockedAt: new Date().toISOString() } },
            { transaction: sqlTransaction },
          );
        }
      });
    } catch {
      throw new TransactionsImportLockedError();
    }

    try {
      return await callback(this);
    } finally {
      // Unlock
      await this.reload();
      await this.update({ data: omit(this.data, ['lockedAt']) });
    }
  }

  async getAllSourceIds(): Promise<Set<string>> {
    const rows = await this.getImportRows({ attributes: ['sourceId'], raw: true });
    return new Set(rows.map(row => row.sourceId));
  }
}

TransactionsImport.init(
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
    UploadedFileId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'UploadedFiles' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    ConnectedAccountId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'ConnectedAccounts' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    source: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true,
      },
    },
    type: {
      type: DataTypes.ENUM(...TransactionsImportTypes),
      allowNull: false,
      validate: {
        isIn: {
          args: [TransactionsImportTypes],
          msg: `Transactions import type must be one of ${TransactionsImportTypes.join(', ')}`,
        },
      },
    },
    settings: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      set(value: TransactionsImportSettings) {
        if (value?.assignments) {
          this.setDataValue('settings', { ...value, assignments: mapValues(value.assignments, uniq) });
        } else {
          this.setDataValue('settings', value);
        }
      },
      validate: {
        isValid(value) {
          const result = settingsSchema.safeParse(value);
          if (!result.success) {
            throw new Error(`Invalid transactions import settings:\n${formatZodError(result.error)}`);
          }
        },
      },
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
      validate: {
        isValid(value) {
          const result = dataSchema.safeParse(value);
          if (!result.success) {
            throw new Error(`Invalid transactions import data:\n${formatZodError(result.error)}`);
          }
        },
      },
    },
    lastSyncAt: {
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
    tableName: 'TransactionsImports',
    paranoid: true, // For soft-deletion
    timestamps: true,
  },
);

export default TransactionsImport;
