import { pick } from 'lodash';
import { CreationOptional, ForeignKey, InferAttributes, InferCreationAttributes, Transaction } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Collective from './Collective';
import User from './User';

export enum HostApplicationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export class HostApplication extends Model<InferAttributes<HostApplication>, InferCreationAttributes<HostApplication>> {
  public declare readonly id: CreationOptional<number>;
  public declare CollectiveId: number;
  public declare HostCollectiveId: number;
  public declare CreatedByUserId: ForeignKey<User['id']>;
  public declare status: HostApplicationStatus;
  public declare customData: Record<string, unknown> | null;
  public declare message: string;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;

  // ---- Static ----

  static async getByStatus(
    host: Collective,
    collective: Collective,
    status: HostApplicationStatus,
  ): Promise<HostApplication | null> {
    return this.findOne({
      order: [['createdAt', 'DESC']],
      where: {
        HostCollectiveId: <number>host.id,
        CollectiveId: collective.id,
        status,
      },
    });
  }

  static async recordApplication(
    host: Collective,
    collective: Collective,
    user: User,
    data: Record<string, unknown>,
  ): Promise<HostApplication> {
    const existingApplication = await this.getByStatus(host, collective, HostApplicationStatus.PENDING);
    if (existingApplication) {
      return existingApplication.update({ updatedAt: new Date() });
    } else {
      return this.create({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        CreatedByUserId: user.id,
        status: HostApplicationStatus.PENDING,
        ...(<Record<string, unknown>>pick(data, ['message', 'customData'])),
      });
    }
  }

  /**
   * Update the `status` for pending application(s) for this `host` <> `collective` (if any)
   */
  static async updatePendingApplications(
    host: Collective,
    collective: Collective,
    status: HostApplicationStatus,
    dbTransaction?: Transaction,
  ): Promise<void> {
    await this.update(
      { status },
      {
        where: {
          HostCollectiveId: host.id,
          CollectiveId: collective.id,
          status: HostApplicationStatus.PENDING,
        },
        transaction: dbTransaction,
      },
    );
  }
}

// Link the model to database fields
HostApplication.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Users' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(HostApplicationStatus)),
      allowNull: false,
      validate: {
        isIn: {
          args: [Object.values(HostApplicationStatus)],
          msg: `Must be one of: ${Object.values(HostApplicationStatus)}`,
        },
      },
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true,
      validate: {
        len: [0, 3000],
      },
    },
    customData: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'HostApplications',
    paranoid: true,
  },
);

export default HostApplication;
