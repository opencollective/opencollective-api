import Temporal from 'sequelize-temporal';

import sequelize, { DataTypes } from '../lib/sequelize';

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

  Subscription.prototype.deactivate = function () {
    this.isActive = false;
    this.deactivatedAt = new Date();

    return this.save();
  };

  Temporal(Subscription, sequelize);

  return Subscription;
}

// We're using the defineModel method to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Subscription = defineModel();

export default Subscription;
