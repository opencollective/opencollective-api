import Promise from 'bluebird';
import debugLib from 'debug';
import { get } from 'lodash';
import Temporal from 'sequelize-temporal';

import { roles } from '../constants';
import status from '../constants/order_status';
import TierType from '../constants/tiers';
import { PLATFORM_TIP_TRANSACTION_PROPERTIES, TransactionTypes } from '../constants/transactions';
import * as libPayments from '../lib/payments';
import sequelize, { DataTypes } from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';
import { capitalize } from '../lib/utils';

import CustomDataTypes from './DataTypes';

const debug = debugLib('models:Order');

function defineModel() {
  const { models } = sequelize;

  const Order = sequelize.define(
    'Order',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },

      CreatedByUserId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Users',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },

      // User|Organization|Collective that is author of this Order
      FromCollectiveId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },

      CollectiveId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },

      TierId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Tiers',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },

      quantity: {
        type: DataTypes.INTEGER,
        validate: {
          min: 1,
        },
      },

      currency: CustomDataTypes(DataTypes).currency,

      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        allowNull: true,
        validate: {
          validateTags,
        },
        set(tags) {
          const sanitizedTags = sanitizeTags(tags);
          if (!sanitizedTags?.length) {
            this.setDataValue('tags', null);
          } else {
            this.setDataValue('tags', sanitizedTags);
          }
        },
      },

      totalAmount: {
        type: DataTypes.INTEGER, // Total amount of the order in cents
        validate: {
          min: 0,
        },
      },

      platformTipAmount: {
        type: DataTypes.INTEGER, // Total amount of the order in cents
        validate: {
          min: 0,
        },
      },

      taxAmount: {
        type: DataTypes.INTEGER,
        validate: {
          min: 0,
        },
      },

      description: DataTypes.STRING,

      publicMessage: {
        type: DataTypes.STRING,
      },

      privateMessage: DataTypes.STRING,

      SubscriptionId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Subscriptions',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },

      PaymentMethodId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'PaymentMethods',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },

      processedAt: DataTypes.DATE,

      status: {
        type: DataTypes.STRING,
        defaultValue: status.NEW,
        allowNull: false,
        validate: {
          isIn: {
            args: [Object.keys(status)],
            msg: `Must be in ${Object.keys(status)}`,
          },
        },
      },

      interval: {
        type: DataTypes.STRING,
        allowNull: true,
      },

      data: {
        type: DataTypes.JSONB,
        allowNull: true,
      },

      createdAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },

      updatedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
      },

      deletedAt: {
        type: DataTypes.DATE,
      },
    },
    {
      paranoid: true,

      getterMethods: {
        // does this payment method support recurring payments?
        recurring() {
          return this.service === 'stripe';
        },

        info() {
          return {
            id: this.id,
            type: get(this, 'collective.type') === 'EVENT' ? 'registration' : 'donation',
            CreatedByUserId: this.CreatedByUserId,
            TierId: this.TierId,
            FromCollectiveId: this.FromCollectiveId,
            CollectiveId: this.CollectiveId,
            currency: this.currency,
            quantity: this.quantity,
            interval: this.interval,
            totalAmount: this.totalAmount,
            platformTipAmount: this.platformTipAmount,
            description: this.description,
            privateMessage: this.privateMessage,
            publicMessage: this.publicMessage,
            SubscriptionId: this.SubscriptionId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            isGuest: Boolean(this.data?.isGuest),
          };
        },

        activity() {
          return {
            id: this.id,
            // totalAmount should not be changed, it's confusing
            totalAmount:
              this.data?.isFeesOnTop && this.data?.platformFee
                ? this.totalAmount - this.data.platformFee
                : this.totalAmount - this.platformTipAmount,
            // introducing 3 new values to clarify
            netAmount:
              this.data?.isFeesOnTop && this.data?.platformFee
                ? this.totalAmount - this.data.platformFee
                : this.totalAmount - this.platformTipAmount,
            platformTipAmount: this.platformTipAmount,
            chargeAmount: this.totalAmount,
            currency: this.currency,
            description: this.description,
            publicMessage: this.publicMessage,
            interval: this.interval,
            quantity: this.quantity,
            createdAt: this.createdAt,
            isGuest: Boolean(this.data?.isGuest),
          };
        },
      },
    },
  );

  /**
   * Static Methods
   */
  Order.generateDescription = (collective, amount, interval, tier) => {
    const tierNameInfo = tier?.name ? ` (${tier.name})` : '';
    if (interval) {
      return `${capitalize(interval)}ly financial contribution to ${collective.name}${tierNameInfo}`;
    } else {
      const isRegistration = tier?.type === TierType.TICKET;
      return `${isRegistration ? 'Registration' : 'Financial contribution'} to ${collective.name}${tierNameInfo}`;
    }
  };

  /**
   * Instance Methods
   */

  // total Transactions over time for this order
  Order.prototype.getTotalTransactions = function () {
    if (!this.SubscriptionId) {
      return this.totalAmount;
    }
    return models.Transaction.sum('amount', {
      where: {
        OrderId: this.id,
        type: TransactionTypes.CREDIT,
      },
    });
  };

  /**
   * This will either create a new payment method or fetch an existing one
   * in which case, this will also make sure that the user can actually use it
   * (need to be a member of admin of the collective if there is a monthlyLimitPerUser or an admin if no limit)
   */
  Order.prototype.setPaymentMethod = function (paymentMethodData) {
    debug('setPaymentMethod', paymentMethodData);
    return this.getUser() // remote user (logged in user) that created the order
      .then(user => models.PaymentMethod.getOrCreate(user, paymentMethodData))
      .then(pm => this.validatePaymentMethod(pm))
      .then(pm => {
        this.paymentMethod = pm;
        this.PaymentMethodId = pm.id;
        return this.save();
      })
      .then(() => this);
  };

  /**
   * Validates the payment method for the current order
   * Makes sure that the user can use this payment method for such order
   */
  Order.prototype.validatePaymentMethod = function (paymentMethod) {
    debug('validatePaymentMethod', paymentMethod.dataValues, 'this.user', this.CreatedByUserId);
    return paymentMethod.canBeUsedForOrder(this, this.createdByUser).then(canBeUsedForOrder => {
      if (canBeUsedForOrder) {
        return paymentMethod;
      } else {
        return null;
      }
    });
  };

  /**
   * Get or create the membership(s) related to this order, including the one related to the
   * platform tip.
   */
  Order.prototype.getOrCreateMembers = async function () {
    // Preload data
    this.collective = this.collective || (await this.getCollective());
    let tier;
    if (this.TierId) {
      tier = await this.getTier();
    }
    // Register user as collective backer or an attendee (for events)
    const member = await this.collective.findOrAddUserWithRole(
      { id: this.CreatedByUserId, CollectiveId: this.FromCollectiveId },
      tier?.type === TierType.TICKET ? roles.ATTENDEE : roles.BACKER,
      { TierId: this.TierId },
      { order: this },
    );

    // Register user as backer of Open Collective
    let platformTipMember;
    if (this.data?.isFeesOnTop && this.data?.platformFee) {
      const platform = await models.Collective.findByPk(PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId);
      platformTipMember = await platform.findOrAddUserWithRole(
        { id: this.CreatedByUserId, CollectiveId: this.FromCollectiveId },
        roles.BACKER,
        {},
        { skipActivity: true },
      );
    }

    return [member, platformTipMember];
  };

  Order.prototype.markAsExpired = async function () {
    // TODO: We should create an activity to record who rejected the order
    return this.update({ status: status.EXPIRED });
  };

  Order.prototype.markAsPaid = async function (user) {
    this.paymentMethod = {
      service: 'opencollective',
      type: 'manual',
      paid: true,
    };

    await libPayments.executeOrder(user, this);
    return this;
  };

  Order.prototype.getUser = function () {
    if (this.createdByUser) {
      return Promise.resolve(this.createdByUser);
    }
    return models.User.findByPk(this.CreatedByUserId).then(user => {
      this.createdByUser = user;
      debug('getUser', user.dataValues);
      return user.populateRoles();
    });
  };

  /**
   * Populate all the foreign keys if necessary
   * (order.fromCollective, order.collective, order.createdByUser, order.tier)
   * @param {*} order
   */
  Order.prototype.populate = function (
    foreignKeys = ['FromCollectiveId', 'CollectiveId', 'CreatedByUserId', 'TierId', 'PaymentMethodId'],
  ) {
    return Promise.map(foreignKeys, fk => {
      const attribute = (fk.substr(0, 1).toLowerCase() + fk.substr(1)).replace(/Id$/, '');
      const model = fk.replace(/(from|to|createdby)/i, '').replace(/Id$/, '');
      const promise = () => {
        if (this[attribute]) {
          return Promise.resolve(this[attribute]);
        }
        if (!this[fk]) {
          return Promise.resolve(null);
        }
        return models[model].findByPk(this[fk]);
      };
      return promise().then(obj => {
        this[attribute] = obj;
      });
    }).then(() => this);
  };

  Order.prototype.getPaymentMethodForUser = function (user) {
    return user.populateRoles().then(() => {
      // this check is necessary to cover organizations as well as user collective
      if (user.isAdmin(this.FromCollectiveId)) {
        return models.PaymentMethod.findByPk(this.PaymentMethodId);
      } else {
        return null;
      }
    });
  };

  Order.prototype.getSubscriptionForUser = function (user) {
    if (!this.SubscriptionId) {
      return null;
    }
    return user.populateRoles().then(() => {
      // this check is necessary to cover organizations as well as user collective
      if (user.isAdmin(this.FromCollectiveId)) {
        return this.getSubscription();
      } else {
        return null;
      }
    });
  };

  Temporal(Order, sequelize);

  return Order;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const Order = defineModel();

export default Order;
