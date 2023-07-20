import type { InferAttributes } from 'sequelize';

import sequelize, { DataTypes, Model } from '../lib/sequelize.js';

import { PaypalProductCreateAttributes } from './PaypalProduct.js';

interface PaypalPlanCommonCreateAttributes {
  id: string;
  currency: string;
  interval: string;
  amount: number;
}

interface PaypalPlanCreateWithProductIdAttributes extends PaypalPlanCommonCreateAttributes {
  ProductId?: string;
}

interface PaypalPlanCreateWithProductAttributes extends PaypalPlanCommonCreateAttributes {
  product?: PaypalProductCreateAttributes;
}

type PaypalPlanCreateAttributes = PaypalPlanCreateWithProductIdAttributes | PaypalPlanCreateWithProductAttributes;

class PaypalPlan extends Model<InferAttributes<PaypalPlan>, PaypalPlanCreateAttributes> {
  public declare id: string;
  public declare ProductId: string;
  public declare currency: string;
  public declare interval: string;
  public declare amount: number;
  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt: Date;
}

PaypalPlan.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
    },
    amount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    interval: {
      type: DataTypes.ENUM('month', 'year'),
      allowNull: false,
    },
    ProductId: {
      type: DataTypes.STRING,
      references: { key: 'id', model: 'PaypalProducts' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
    tableName: 'PaypalPlans',
    paranoid: true,
  },
);

export default PaypalPlan;
