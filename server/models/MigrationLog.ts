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
  name: string;
  data: Record<string, unknown>;
}

interface MigrationLogCommonCreateAttributes {
  type: MigrationLogType;
  name: string;
  data: Record<string, unknown>;
}

class MigrationLog
  extends Model<MigrationLogAttributes, MigrationLogCommonCreateAttributes>
  implements MigrationLogAttributes
{
  id: number;
  type: MigrationLogType;
  createdAt: Date;
  name: string;
  data: Record<string, unknown>;

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
    name: {
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
  },
  {
    sequelize,
    tableName: 'MigrationLogs',
    paranoid: false,
    updatedAt: false,
  },
);

export default MigrationLog;
