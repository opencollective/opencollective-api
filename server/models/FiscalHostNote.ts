import type { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, NonAttribute } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';
import User from './User';

export type FiscalHostNoteLevel = 'WARNING' | 'INFO' | 'POSITIVE';

/**
 * A host-private note about an account, set by an admin of the fiscal host.
 * One note per (HostCollectiveId, CollectiveId); saving again overwrites it.
 */
class FiscalHostNote extends Model<InferAttributes<FiscalHostNote>, InferCreationAttributes<FiscalHostNote>> {
  public static readonly tableName = 'FiscalHostNotes' as const;

  declare public id: CreationOptional<number>;
  declare public type: FiscalHostNoteLevel;
  declare public note: string;

  declare public HostCollectiveId: ForeignKey<Collective['id']>;
  declare public CollectiveId: ForeignKey<Collective['id']>;
  declare public CreatedByUserId: ForeignKey<User['id']> | null;
  declare public UpdatedByUserId: ForeignKey<User['id']> | null;

  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;

  declare public host?: NonAttribute<Collective>;
  declare public account?: NonAttribute<Collective>;
  declare public createdByUser?: NonAttribute<User>;
  declare public updatedByUser?: NonAttribute<User>;
}

FiscalHostNote.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [['WARNING', 'INFO', 'POSITIVE']],
      },
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: {
        len: [1, 5000],
      },
    },
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'Users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    UpdatedByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'Users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
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
  },
  {
    sequelize,
    tableName: 'FiscalHostNotes',
    indexes: [{ unique: true, fields: ['HostCollectiveId', 'CollectiveId'] }],
  },
);

export default FiscalHostNote;
