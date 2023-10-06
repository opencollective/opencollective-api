import { InferAttributes, InferCreationAttributes, Model, ModelStatic } from 'sequelize';
import Temporal from 'sequelize-temporal';

import sequelize, { DataTypes } from '../lib/sequelize';
import { cancelPaypalSubscription } from '../paymentProviders/paypal/subscription';

import Collective from './Collective';
import CustomDataTypes from './DataTypes';

export interface SubscriptionInterface
  extends Model<InferAttributes<SubscriptionInterface>, InferCreationAttributes<SubscriptionInterface>> {
  id: number;
  amount: number;
  currency: string;
  interval: 'month' | 'year' | null;
  isActive: boolean;
  nextChargeDate: Date;
  nextPeriodStart: Date;
  chargeRetryCount: number;
  quantity: number;
  chargeNumber: number;
  data: Record<string, unknown>;
  stripeSubscriptionId: string;
  paypalSubscriptionId: string;
  isManagedExternally: boolean;
  activatedAt: Date;
  deactivatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date;

  activate(): Promise<SubscriptionInterface>;
  deactivate(reason?: string, host?: Collective): Promise<SubscriptionInterface>;
}

const Subscription: ModelStatic<SubscriptionInterface> = sequelize.define(
  'Subscription',
  {
    amount: {
      type: DataTypes.INTEGER,
      validate: { min: 0 },
    },

    currency: CustomDataTypes(DataTypes).currency,

    interval: {
      type: DataTypes.STRING(8),
      validate: {
        isIn: {
          args: [['month', 'year']],
          msg: 'Must be month or year',
        },
      },
    },

    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    nextChargeDate: DataTypes.DATE,

    nextPeriodStart: DataTypes.DATE,

    chargeRetryCount: DataTypes.INTEGER,

    quantity: DataTypes.INTEGER,

    chargeNumber: DataTypes.INTEGER,

    data: DataTypes.JSONB,

    stripeSubscriptionId: DataTypes.STRING,

    paypalSubscriptionId: { type: DataTypes.STRING, allowNull: true },

    isManagedExternally: { type: DataTypes.BOOLEAN, defaultValue: false },

    activatedAt: DataTypes.DATE,

    deactivatedAt: DataTypes.DATE,

    deletedAt: DataTypes.DATE,
  },
  {
    paranoid: true,
  },
);

Subscription.prototype.activate = function () {
  this.isActive = true;
  this.activatedAt = new Date();

  return this.save();
};

Subscription.prototype.deactivate = async function (reason = undefined, host = undefined) {
  // If subscription exists on a third party, cancel it there
  if (this.paypalSubscriptionId) {
    const order = await this.getOrder();
    order.Subscription = this;
    await cancelPaypalSubscription(order, reason, host);
  }

  return this.update({ isActive: false, deactivatedAt: new Date() });
};

Temporal(Subscription, sequelize);

export default Subscription;
