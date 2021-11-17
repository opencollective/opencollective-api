import Temporal from 'sequelize-temporal';

import sequelize, { DataTypes } from '../lib/sequelize';
import { cancelPaypalSubscription } from '../paymentProviders/paypal/subscription';

import CustomDataTypes from './DataTypes';

function defineModel() {
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
            args: [['week', 'month', 'year']],
            msg: 'Must be week, month or year',
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

  Subscription.prototype.deactivate = async function (reason) {
    // If subscription exists on a third party, cancel it there
    if (this.paypalSubscriptionId) {
      const order = await this.getOrder();
      order.Subscription = this;
      await cancelPaypalSubscription(order, reason);
    }

    return this.update({ isActive: false, deactivatedAt: new Date() });
  };

  Temporal(Subscription, sequelize);

  return Subscription;
}

// We're using the defineModel method to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Subscription = defineModel();

export default Subscription;
