import type { InferAttributes } from 'sequelize';

import { SupportedCurrency } from '../constants/currencies';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import { PaypalProductCreateAttributes } from './PaypalProduct';

interface PaypalPlanCommonCreateAttributes {
  id: string;
  currency: SupportedCurrency;
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
  declare public id: string;
  declare public ProductId: string;
  declare public currency: SupportedCurrency;
  declare public interval: string;
  declare public amount: number;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt: Date;
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
