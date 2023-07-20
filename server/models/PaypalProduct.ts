import { InferAttributes } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize.js';

export interface PaypalProductCreateAttributes {
  id: string;
  TierId: number;
  CollectiveId: number;
}

class PaypalProduct extends Model<InferAttributes<PaypalProduct>, PaypalProductCreateAttributes> {
  public declare id: string;
  public declare CollectiveId: number;
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
