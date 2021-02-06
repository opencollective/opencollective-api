import { pick } from 'lodash';
import { DataTypes, Model, Sequelize } from 'sequelize';

import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';

export enum HostApplicationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export class HostApplication extends Model<HostApplication> {
  public readonly id!: number;
  public CollectiveId!: number;
  public HostCollectiveId!: number;
  public status!: HostApplicationStatus;
  public customData: Record<string, unknown> | null;
  public message: string;
  public createdAt!: Date;
  public updatedAt!: Date;
  public deletedAt: Date | null;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

  // ---- Static ----

  static async getByStatus(host, collective, status: HostApplicationStatus): Promise<HostApplication | null> {
    return this.findOne({
      order: [['createdAt', 'DESC']],
      where: {
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        status,
      },
    });
  }

  static async recordApplication(host, collective, data: Record<string, unknown>): Promise<HostApplication> {
    const existingApplication = await this.getByStatus(host, collective, HostApplicationStatus.PENDING);
    if (existingApplication) {
      return existingApplication.update({ updatedAt: new Date() });
    } else {
      return this.create({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        status: HostApplicationStatus.PENDING,
        ...pick(data, ['message', 'customData']),
      });
    }
  }

  /**
   * Update the `status` for pending application(s) for this `host` <> `collective` (if any)
   */
  static async updatePendingApplications(host, collective, status: HostApplicationStatus): Promise<void> {
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

export default (sequelize: Sequelize): typeof HostApplication => {
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

  return HostApplication;
};
