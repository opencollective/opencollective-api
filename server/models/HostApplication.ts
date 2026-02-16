import { pick } from 'lodash';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';

import { activities } from '../constants';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import Activity from './Activity';
import Collective from './Collective';
import User from './User';

export enum HostApplicationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

class HostApplication extends Model<InferAttributes<HostApplication>, InferCreationAttributes<HostApplication>> {
  public static readonly tableName = 'HostApplications' as const;

  declare public readonly id: CreationOptional<number>;
  declare public CollectiveId: number;
  declare public HostCollectiveId: number;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public status: HostApplicationStatus;
  declare public customData: Record<string, unknown> | null;
  declare public message: string;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;

  declare public collective?: NonAttribute<Collective>;
  declare public getCollective: BelongsToGetAssociationMixin<Collective>;

  declare public host?: NonAttribute<Collective>;
  declare public getHost: BelongsToGetAssociationMixin<Collective>;

  // ---- Static ----

  static async recordApplication(
    host: Collective,
    collective: Collective,
    user: User,
    status: HostApplicationStatus,
    data: Record<string, unknown>,
  ): Promise<HostApplication> {
    let application = await this.findOne({
      order: [['createdAt', 'DESC']],
      where: {
        HostCollectiveId: <number>host.id,
        CollectiveId: collective.id,
        status,
      },
    });
    if (application) {
      application.update({ updatedAt: new Date() });
    } else {
      application = await this.create({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        CreatedByUserId: user.id,
        status,
        ...(<Record<string, unknown>>pick(data, ['message', 'customData'])),
      });
    }

    if (status === HostApplicationStatus.APPROVED) {
      await Activity.create({
        type: activities.COLLECTIVE_APPROVED,
        UserId: user.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        data: {
          collective: collective.info,
          host: host.info,
          user: { email: user.email },
        },
      });
    }

    return application;
  }

  /**
   * Update the `status` for pending application(s) for this `host` <> `collective` (if any)
   */
  static async updatePendingApplications(
    host: Collective,
    collective: Collective,
    status: HostApplicationStatus,
  ): Promise<void> {
    await this.update(
      { status },
      {
        where: {
          HostCollectiveId: host.id,
          CollectiveId: collective.id,
          status: HostApplicationStatus.PENDING,
        },
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
