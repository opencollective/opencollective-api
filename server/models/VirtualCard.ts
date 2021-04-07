import { isNil } from 'lodash';

import { crypto } from '../lib/encryption';
import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

interface VirtualCardAttributes {
  id: string;
  CollectiveId: number;
  HostCollectiveId: number;
  name: string;
  last4: string;
  data: Record<string, any>;
  privateData: string | Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

export interface VirtualCardCreateAttributes {
  id: string;
  CollectiveId: number;
  HostCollectiveId: number;
}

class VirtualCard extends Model<VirtualCardAttributes, VirtualCardCreateAttributes> implements VirtualCardAttributes {
  public id!: string;
  public CollectiveId!: number;
  public HostCollectiveId!: number;
  public name: string;
  public last4: string;
  public data: Record<string, any>;
  public privateData: string | Record<string, any>;
  public createdAt!: Date;
  public updatedAt!: Date;
  public deletedAt: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
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
        return isNil(encrypted) ? null : JSON.parse(crypto.decrypt(encrypted as string));
      },
      set(value) {
        this.setDataValue('privateData', crypto.encrypt(JSON.stringify(value)));
      },
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
