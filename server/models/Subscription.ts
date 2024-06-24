import { InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import Temporal from 'sequelize-temporal';

import { SupportedCurrency } from '../constants/currencies';
import sequelize, { DataTypes } from '../lib/sequelize';
import { cancelPaypalSubscription } from '../paymentProviders/paypal/subscription';

import Collective from './Collective';
import CustomDataTypes from './DataTypes';

class Subscription extends Model<InferAttributes<Subscription>, InferCreationAttributes<Subscription>> {
  declare id: number;
  declare amount: number;
  declare currency: SupportedCurrency;
  declare interval: 'month' | 'year' | null;
  declare isActive: boolean;
  declare nextChargeDate: Date;
  declare nextPeriodStart: Date;
  declare chargeRetryCount: number;
  declare quantity: number;
  declare chargeNumber: number;
  declare data: Record<string, unknown>;
  declare stripeSubscriptionId: string;
  declare paypalSubscriptionId: string;
  declare isManagedExternally: boolean;
  declare activatedAt: Date;
  declare deactivatedAt: Date;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare deletedAt: Date;

  // Class methods
  declare activate: () => Promise<Subscription>;
  declare deactivate: (reason?: string, host?: Collective) => Promise<Subscription>;
}

Subscription.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

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

    createdAt: DataTypes.DATE,

    updatedAt: DataTypes.DATE,

    deletedAt: DataTypes.DATE,
  },
  {
    sequelize,
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
