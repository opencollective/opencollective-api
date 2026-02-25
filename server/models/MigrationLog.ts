import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes } from 'sequelize';

import sequelize, { DataTypes } from '../lib/sequelize';

import { ModelWithPublicId } from './ModelWithPublicId';
import User from './User';

export enum MigrationLogType {
  MIGRATION = 'MIGRATION',
  MANUAL = 'MANUAL',
  MERGE_ACCOUNTS = 'MERGE_ACCOUNTS',
  BAN_ACCOUNTS = 'BAN_ACCOUNTS',
  MOVE_ORDERS = 'MOVE_ORDERS',
  MOVE_EXPENSES = 'MOVE_EXPENSES',
  MODEL_FIX = 'MODEL_FIX',
}

export type MigrationLogDataForMergeAccounts = {
  fromAccount?: number;
  intoAccount?: number;
  fromUser?: number;
  intoUser?: number;
  associations?: Record<string, unknown[]>;
  userChanges?: Record<string, (number | string)[]> | null;
};

type MigrationLogData = MigrationLogDataForMergeAccounts | Record<string, unknown>;

class MigrationLog extends ModelWithPublicId<InferAttributes<MigrationLog>, InferCreationAttributes<MigrationLog>> {
  public static readonly nanoIdPrefix = 'migr' as const;
  public static readonly tableName = 'MigrationLogs' as const;

  declare public id: CreationOptional<number>;
  declare public readonly publicId: string;
  declare public type: MigrationLogType;
  declare public createdAt: CreationOptional<Date>;
  declare public description: string;
  declare public data: MigrationLogData;
  declare public CreatedByUserId: ForeignKey<User['id']>;

  static async getDataForMergeAccounts(
    fromAccountId: number,
    toAccountId: number,
  ): Promise<MigrationLogDataForMergeAccounts | null> {
    const migrationLog = await MigrationLog.findOne({
      where: {
        type: MigrationLogType.MERGE_ACCOUNTS,
        data: {
          fromAccount: fromAccountId,
          toAccount: toAccountId,
        },
      },
    });

    return migrationLog?.data || null;
  }
}

MigrationLog.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    publicId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(MigrationLogType)),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: '{}',
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'MigrationLogs',
    paranoid: false,
    updatedAt: false,
  },
);

export default MigrationLog;
