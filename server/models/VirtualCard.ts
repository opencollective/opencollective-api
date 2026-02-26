import moment from 'moment';
import type {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  NonAttribute,
} from 'sequelize';

import { SupportedCurrency } from '../constants/currencies';
import VirtualCardProviders from '../constants/virtual-card-providers';
import { crypto } from '../lib/encryption';
import sequelize, { DataTypes, Op } from '../lib/sequelize';
import * as stripeVirtualCards from '../paymentProviders/stripe/virtual-cards';

import Collective from './Collective';
import Expense from './Expense';
import { ModelWithPublicId } from './ModelWithPublicId';
import User from './User';
import VirtualCardRequest from './VirtualCardRequest';

export enum VirtualCardStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  CANCELED = 'canceled',
}

class VirtualCard extends ModelWithPublicId<
  InferAttributes<VirtualCard, { omit: 'info' }>,
  InferCreationAttributes<VirtualCard>
> {
  public static readonly nanoIdPrefix = 'vcard' as const;
  public static readonly tableName = 'VirtualCards' as const;

  declare public id: CreationOptional<string>;
  declare public readonly publicId: string;
  declare public CollectiveId: number;
  declare public HostCollectiveId: number;
  declare public UserId: ForeignKey<User['id']>;
  declare public VirtualCardRequestId: ForeignKey<VirtualCardRequest['id']>;
  declare public name: string;
  declare public last4: string;
  declare public data: Record<string, any>;
  declare public privateData: string | Record<string, any>;
  declare public provider: VirtualCardProviders;
  declare public spendingLimitAmount: number;
  declare public spendingLimitInterval: string;
  declare public currency: SupportedCurrency;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
  declare public resumedAt: CreationOptional<Date>;

  // Associations
  declare public collective?: NonAttribute<any>;
  declare public host?: NonAttribute<Collective>;
  declare public getHost: BelongsToGetAssociationMixin<Collective>;
  declare public user?: NonAttribute<any>;

  declare public virtualCardRequest?: NonAttribute<VirtualCardRequest>;
  declare public getVirtualCardRequest?: BelongsToGetAssociationMixin<VirtualCardRequest>;

  async getExpensesMissingDetails(): Promise<Array<any>> {
    return Expense.findPendingCardCharges({
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
      resumedAt: new Date(),
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
    },
    publicId: {
      type: DataTypes.STRING,
      unique: true,
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
        } catch {
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
    resumedAt: {
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
