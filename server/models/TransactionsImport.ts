import { omit } from 'lodash';
import type {
  BelongsToGetAssociationMixin,
  ForeignKey,
  HasManyCreateAssociationMixin,
  HasManyGetAssociationsMixin,
  InferAttributes,
  InferCreationAttributes,
  Transaction as SequelizeTransaction,
} from 'sequelize';

import ActivityTypes from '../constants/activities';
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

type TransactionsImportSettings = {
  csvConfig?: Record<string, unknown>;
};

type TransactionsImportData = {
  lockedAt?: string;
  plaid?: {
    lastSyncCursor?: string;
    syncAttempt?: number;
    lastSyncErrorMessage?: string;
  };
};

// A custom error type for when a transaction import is locked
export class TransactionsImportLockedError extends Error {
  constructor() {
    super('This import is already locked');
    this.name = 'TransactionsImportLockedError';
  }
}

class TransactionsImport extends Model<InferAttributes<TransactionsImport>, CreationAttributes> {
  public declare id: number;
  public declare CollectiveId: ForeignKey<Collective['id']>;
  public declare UploadedFileId: ForeignKey<UploadedFile['id']>;
  public declare ConnectedAccountId: ForeignKey<ConnectedAccount['id']>;
  public declare source: string;
  public declare name: string;
  public declare type: (typeof TransactionsImportTypes)[number];
  public declare settings: TransactionsImportSettings | null;
  public declare data: TransactionsImportData | null;
  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt: Date;
  public declare lastSyncAt: Date;

  public declare collective?: Collective;
  public declare getCollective: BelongsToGetAssociationMixin<Collective>;
  public declare importRows?: TransactionsImportRow[];
  public declare getImportRows: HasManyGetAssociationsMixin<TransactionsImportRow>;
  public declare createImportRow: HasManyCreateAssociationMixin<TransactionsImportRow>;

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
    // @deprecated: We've moved this to `settings.csvConfig`. Keeping it here until it's deleted from the database with a migration.
    // csvConfig: {
    //   type: DataTypes.JSONB,
    //   allowNull: true,
    // },
    settings: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
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
