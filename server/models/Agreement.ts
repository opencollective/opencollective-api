import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  DataTypes,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
} from 'sequelize';

import sequelize from '../lib/sequelize';

import Collective from './Collective';
import UploadedFile from './UploadedFile';
import User from './User';

export default class Agreement extends Model<InferAttributes<Agreement>, InferCreationAttributes<Agreement>> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare expiresAt: CreationOptional<Date>;

  declare UserId: ForeignKey<User['id']>;
  declare User?: User;
  declare getUser: BelongsToGetAssociationMixin<User>;

  declare HostCollectiveId: ForeignKey<Collective['id']>;
  declare Host?: NonAttribute<Collective>;
  declare getHost: BelongsToGetAssociationMixin<Collective>;

  declare CollectiveId: ForeignKey<Collective['id']>;
  declare Collective?: NonAttribute<Collective>;
  declare getCollective: BelongsToGetAssociationMixin<Collective>;

  declare UploadedFileId: ForeignKey<UploadedFile['id']>;
  declare UploadedFile?: NonAttribute<UploadedFile>;
  declare getUploadedFile: BelongsToGetAssociationMixin<UploadedFile>;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;
}

Agreement.init(
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    expiresAt: {
      allowNull: true,
      type: DataTypes.DATE,
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      allowNull: true,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      allowNull: true,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      allowNull: true,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    UploadedFileId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'UploadedFiles' },
      allowNull: true,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
  },
  {
    sequelize,
    tableName: 'Agreements',
    paranoid: true,
  },
);
