import moment from 'moment';
import type {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';

import VirtualCardProviders from '../constants/virtual_card_providers';
import { crypto } from '../lib/encryption';
import sequelize, { DataTypes, Model, Op } from '../lib/sequelize';
import * as stripeVirtualCards from '../paymentProviders/stripe/virtual-cards';

import Collective from './Collective';
import User from './User';
import VirtualCardRequest from './VirtualCardRequest';

export enum VirtualCardStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  CANCELED = 'canceled',
}

class VirtualCard extends Model<InferAttributes<VirtualCard, { omit: 'info' }>, InferCreationAttributes<VirtualCard>> {
  public declare id: CreationOptional<string>;
  public declare CollectiveId: number;
  public declare HostCollectiveId: number;
  public declare UserId: ForeignKey<User['id']>;
  public declare VirtualCardRequestId: ForeignKey<VirtualCardRequest['id']>;
  public declare name: string;
  public declare last4: string;
  public declare data: Record<string, any>;
  public declare privateData: string | Record<string, any>;
  public declare provider: VirtualCardProviders;
  public declare spendingLimitAmount: number;
  public declare spendingLimitInterval: string;
  public declare currency: string;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;
  public declare lastResumedAt: CreationOptional<Date>;

  // Associations
  public declare collective?: NonAttribute<any>;
  public declare host?: NonAttribute<Collective>;
  public declare getHost: BelongsToGetAssociationMixin<Collective>;
  public declare user?: NonAttribute<any>;

  public declare virtualCardRequest?: NonAttribute<VirtualCardRequest>;
  public declare getVirtualCardRequest?: BelongsToGetAssociationMixin<VirtualCardRequest>;

  async getExpensesMissingDetails(): Promise<Array<any>> {
    return sequelize.models.Expense.findPendingCardCharges({
      where: { VirtualCardId: this.id, createdAt: { [Op.lte]: moment.utc().subtract(30, 'days') } },
    });
  }

  async pause() {
    switch (this.provider) {
      case VirtualCardProviders.STRIPE:
        await stripeVirtualCards.pauseCard(this);
        break;
      default:
        throw new Error(`Can not suspend virtual card provided by ${this.provider}`);
    }

    await this.update({
      data: {
        ...this.data,
        status: VirtualCardStatus.INACTIVE,
      },
    });

    return this.reload();
  }

  async resume() {
    switch (this.provider) {
      case VirtualCardProviders.STRIPE:
        await stripeVirtualCards.resumeCard(this);
        break;
      default:
        throw new Error(`Can not resume virtual card provided by ${this.provider}`);
    }

    await this.update({
      lastResumedAt: new Date(),
      data: {
        ...this.data,
        status: VirtualCardStatus.ACTIVE,
      },
    });

    return this.reload();
  }

  async delete() {
    switch (this.provider) {
      case VirtualCardProviders.STRIPE:
        if (this.data.status === VirtualCardStatus.CANCELED) {
          return;
        }
        await stripeVirtualCards.deleteCard(this);
        await this.update({
          data: {
            ...this.data,
            status: VirtualCardStatus.CANCELED,
          },
        });
        break;
      default:
        throw new Error(`Can not delete virtual card provided by ${this.provider}`);
    }
  }

  isActive() {
    return this.data?.status === 'active' || this.data?.state === 'OPEN';
  }

  isPaused() {
    return this.data?.status === 'inactive' || this.data?.state === 'PAUSED';
  }

  get info() {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      last4: this.last4,
      CollectiveId: this.CollectiveId,
      HostCollectiveId: this.HostCollectiveId,
    };
  }
}

VirtualCard.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: { model: 'Collectives', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: { model: 'Users', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    last4: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    privateData: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        const encrypted = this.getDataValue('privateData');
        try {
          return JSON.parse(crypto.decrypt(encrypted as string));
        } catch (e) {
          return null;
        }
      },
      set(value) {
        this.setDataValue('privateData', crypto.encrypt(JSON.stringify(value)));
      },
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    spendingLimitAmount: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    spendingLimitInterval: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    currency: {
      type: DataTypes.STRING,
      defaultValue: 'USD',
      allowNull: false,
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
    },
    lastResumedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'VirtualCards',
    paranoid: true,
  },
);

export default VirtualCard;
