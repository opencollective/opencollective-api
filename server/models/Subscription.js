import Temporal from 'sequelize-temporal';

import sequelize, { DataTypes } from '../lib/sequelize';
import { cancelPaypalSubscription } from '../paymentProviders/paypal/subscription';

import CustomDataTypes from './DataTypes';

const Subscription = sequelize.define(
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

Subscription.prototype.deactivate = async function (reason, host) {
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
