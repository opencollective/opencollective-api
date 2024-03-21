import { InferAttributes } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize';

export interface PaypalProductCreateAttributes {
  id: string;
  TierId: number;
  CollectiveId: number;
  HostCollectiveId: number;
}

class PaypalProduct extends Model<InferAttributes<PaypalProduct>, PaypalProductCreateAttributes> {
  public declare id: string;
  public declare CollectiveId: number;
  public declare HostCollectiveId: number;
  public declare TierId: number;
  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt: Date;
}

PaypalProduct.init(
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
      allowNull: true, // Should be switched to false once all products have a host. We have set values for all currently hosted collectives, but unhosted ones will have null.
    },
    TierId: {
      type: DataTypes.INTEGER,
      references: { model: 'Tiers', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
    },
  },
  {
    sequelize,
    tableName: 'PaypalProducts',
    paranoid: true,
  },
);

export default PaypalProduct;
