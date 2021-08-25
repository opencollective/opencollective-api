import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

export enum MigrationLogType {
  MIGRATION = 'MIGRATION',
  MANUAL = 'MANUAL',
  MERGE_ACCOUNTS = 'MERGE_ACCOUNTS',
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

class MigrationLog
  extends Model<MigrationLogAttributes, MigrationLogCommonCreateAttributes>
  implements MigrationLogAttributes
{
  id: number;
  type: MigrationLogType;
  createdAt: Date;
  description: string;
  data: Record<string, unknown>;
  CreatedByUserId: number;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
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
      type: DataTypes.ENUM('MIGRATION', 'MANUAL', 'MERGE_ACCOUNTS'),
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
