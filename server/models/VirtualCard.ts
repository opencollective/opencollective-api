import { crypto } from '../lib/encryption';
import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';
import privacyVirtualCards from '../paymentProviders/privacy';
import * as stripeVirtualCards from '../paymentProviders/stripe/virtual-cards';

export enum VirtualCardProviders {
  PRIVACY = 'PRIVACY',
  STRIPE = 'STRIPE',
}

interface VirtualCardAttributes {
  id: string;
  CollectiveId: number;
  HostCollectiveId: number;
  UserId?: number;
  name: string;
  last4: string;
  data: Record<string, any>;
  privateData: string | Record<string, any>;
  provider: VirtualCardProviders;
  spendingLimitAmount: number;
  spendingLimitInterval: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

export interface VirtualCardCreateAttributes {
  id: string;
  name: string;
  last4: string;
  data: Record<string, any>;
  privateData: Record<string, any>;
  CollectiveId: number;
  HostCollectiveId: number;
  UserId?: number;
  provider: VirtualCardProviders;
  spendingLimitAmount: number;
  spendingLimitInterval: string;
  currency?: string;
}

class VirtualCard extends Model<VirtualCardAttributes, VirtualCardCreateAttributes> implements VirtualCardAttributes {
  public id!: string;
  public CollectiveId!: number;
  public HostCollectiveId!: number;
  public UserId: number;
  public name: string;
  public last4: string;
  public data: Record<string, any>;
  public privateData: string | Record<string, any>;
  public provider: VirtualCardProviders;
  public spendingLimitAmount: number;
  public spendingLimitInterval: string;
  public currency: string;
  public createdAt!: Date;
  public updatedAt!: Date;
  public deletedAt: Date;
  // Associations
  collective?: any;
  host?: any;
  user?: any;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

  async getExpensesMissingDetails(): Promise<Array<any>> {
    return sequelize.models.Expense.findAll({
      where: { VirtualCardId: this.id, data: { missingDetails: true } },
    });
  }

  async pause() {
    switch (this.provider) {
      case VirtualCardProviders.STRIPE:
        await stripeVirtualCards.pauseCard(this);
        break;
      case VirtualCardProviders.PRIVACY:
        await privacyVirtualCards.pauseCard(this);
        break;
      default:
        throw new Error(`Can not suspend virtual card provided by ${this.provider}`);
    }

    return this.reload();
  }

  async resume() {
    switch (this.provider) {
      case VirtualCardProviders.STRIPE:
        await stripeVirtualCards.resumeCard(this);
        break;
      case VirtualCardProviders.PRIVACY:
        await privacyVirtualCards.resumeCard(this);
        break;
      default:
        throw new Error(`Can not resume virtual card provided by ${this.provider}`);
    }

    return this.reload();
  }

  async delete() {
    switch (this.provider) {
      case VirtualCardProviders.STRIPE:
        await stripeVirtualCards.deleteCard(this);
        break;
      case VirtualCardProviders.PRIVACY:
        await privacyVirtualCards.deleteCard(this);
        break;
      default:
        throw new Error(`Can not resume virtual card provided by ${this.provider}`);
    }

    await this.destroy();
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
  },
  {
    sequelize,
    tableName: 'VirtualCards',
    paranoid: true,
  },
);

export default VirtualCard;
