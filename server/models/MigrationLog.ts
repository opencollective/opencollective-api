import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

export enum MigrationLogType {
  MIGRATION = 'MIGRATION',
  MANUAL = 'MANUAL',
  MERGE_ACCOUNTS = 'MERGE_ACCOUNTS',
  MOVE_ORDERS = 'MOVE_ORDERS',
}

interface MigrationLogAttributes {
  id: number;
  type: MigrationLogType;
  createdAt: Date;
  description: string;
  data: Record<string, unknown>;
  CreatedByUserId: number;
}

interface MigrationLogCommonCreateAttributes {
  type: MigrationLogType;
  description: string;
  data: Record<string, unknown>;
  CreatedByUserId: number;
}

export type MigrationLogDataForMergeAccounts = {
  fromAccount?: number;
  intoAccount?: number;
  fromUser?: number;
  intoUser?: number;
  associations?: Record<string, (number | string)[]>;
  userChanges?: Record<string, (number | string)[]> | null;
};

type MigrationLogData = MigrationLogDataForMergeAccounts | Record<string, unknown>;

class MigrationLog
  extends Model<MigrationLogAttributes, MigrationLogCommonCreateAttributes>
  implements MigrationLogAttributes
{
  id: number;
  type: MigrationLogType;
  createdAt: Date;
  description: string;
  data: MigrationLogData;
  CreatedByUserId: number;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

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
