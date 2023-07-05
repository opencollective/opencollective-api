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

import { VirtualCardLimitIntervals } from '../constants/virtual-cards';
import sequelize from '../lib/sequelize';

import Collective from './Collective';
import User from './User';

export enum VirtualCardRequestStatus {
  PENDING = 'PENDING',
}

export default class VirtualCardRequest extends Model<
  InferAttributes<VirtualCardRequest>,
  InferCreationAttributes<VirtualCardRequest>
> {
  declare id: CreationOptional<number>;
  declare purpose: string;
  declare notes: string;
  declare status: VirtualCardRequestStatus;
  declare currency: string;
  declare spendingLimitAmount: number;
  declare spendingLimitInterval: VirtualCardLimitIntervals;

  declare UserId: ForeignKey<User['id']>;
  declare user?: NonAttribute<User>;
  declare getUser: BelongsToGetAssociationMixin<User>;

  declare HostCollectiveId: ForeignKey<Collective['id']>;
  declare host?: NonAttribute<Collective>;
  declare getHost: BelongsToGetAssociationMixin<Collective>;

  declare CollectiveId: ForeignKey<Collective['id']>;
  declare collective?: NonAttribute<Collective>;
  declare getCollective: BelongsToGetAssociationMixin<Collective>;

  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;

  get info(): NonAttribute<
    Pick<
      VirtualCardRequest,
      | 'id'
      | 'purpose'
      | 'notes'
      | 'status'
      | 'currency'
      | 'spendingLimitAmount'
      | 'spendingLimitInterval'
      | 'UserId'
      | 'CollectiveId'
      | 'HostCollectiveId'
      | 'createdAt'
      | 'updatedAt'
      | 'deletedAt'
    >
  > {
    return {
      id: this.id,
      purpose: this.purpose,
      notes: this.notes,
      status: this.status,
      currency: this.currency,
      spendingLimitAmount: this.spendingLimitAmount,
      spendingLimitInterval: this.spendingLimitInterval,
      UserId: this.UserId,
      CollectiveId: this.CollectiveId,
      HostCollectiveId: this.HostCollectiveId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt,
    };
  }
}

VirtualCardRequest.init(
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    purpose: {
      type: DataTypes.STRING,
      allowNull: false,
      set(val: string) {
        this.setDataValue('purpose', val?.trim());
      },
      validate: {
        len: [1, 60],
        notEmpty: true,
      },
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      set(val: string) {
        this.setDataValue('notes', val?.trim());
      },
      validate: {
        len: [1, 3000],
        notEmpty: true,
      },
    },
    status: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: VirtualCardRequestStatus.PENDING,
    },
    currency: {
      allowNull: false,
      type: DataTypes.TEXT,
    },
    spendingLimitAmount: {
      allowNull: false,
      type: DataTypes.INTEGER,
    },
    spendingLimitInterval: {
      allowNull: false,
      type: DataTypes.TEXT,
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
    tableName: 'VirtualCardRequests',
    paranoid: true,
  },
);
