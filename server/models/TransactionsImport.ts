import type {
  BelongsToGetAssociationMixin,
  CreationOptional,
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
import TransactionsImportRow from './TransactionsImportRow';
import UploadedFile from './UploadedFile';
import User from './User';

// For some reason `CreationOptional` is not enough to make fields optional
type CreationAttributes = InferCreationAttributes<
  TransactionsImport,
  { omit: 'id' | 'csvConfig' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'UploadedFileId' }
>;

export const TransactionsImportTypes = ['CSV', 'MANUAL', 'PLAID'] as const;

class TransactionsImport extends Model<InferAttributes<TransactionsImport>, CreationAttributes> {
  public declare id: CreationOptional<number>;
  public declare CollectiveId: ForeignKey<Collective['id']>;
  public declare UploadedFileId: CreationOptional<ForeignKey<UploadedFile['id']>>;
  public declare source: string;
  public declare name: string;
  public declare type: (typeof TransactionsImportTypes)[number];
  public declare csvConfig: CreationOptional<Record<string, unknown>> | null;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;

  public declare collective?: Collective;
  public declare getCollective: BelongsToGetAssociationMixin<Collective>;
  public declare importRows?: TransactionsImportRow[];
  public declare getImportRows: HasManyGetAssociationsMixin<TransactionsImportRow>;
  public declare createImportRow: HasManyCreateAssociationMixin<TransactionsImportRow>;

  static async createWithActivity(
    remoteUser: User,
    collective: Collective,
    attributes: Omit<CreationAttributes, 'CollectiveId'>,
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

  async addRows(data, { transaction }) {
    return TransactionsImportRow.bulkCreate(
      data.map(row => ({ ...row, TransactionsImportId: this.id })),
      { transaction },
    );
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
    csvConfig: {
      type: DataTypes.JSONB,
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
