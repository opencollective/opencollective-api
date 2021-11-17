import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

import { PaypalProductCreateAttributes } from './PaypalProduct';

interface PaypalPlanAttributes {
  id: string;
  ProductId: string;
  currency: string;
  interval: string;
  amount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;
}

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

class PaypalPlan extends Model<PaypalPlanAttributes, PaypalPlanCreateAttributes> implements PaypalPlanAttributes {
  id: string;
  ProductId: string;
  currency: string;
  interval: string;
  amount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }
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
      type: DataTypes.ENUM('week', 'month', 'year'),
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
