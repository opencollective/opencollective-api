import config from 'config';
import debugLib from 'debug';
import { get, intersection } from 'lodash';
import { InferAttributes, InferCreationAttributes, Model } from 'sequelize';

import { SupportedCurrency } from '../constants/currencies';
import { maxInteger } from '../constants/math';
import {
  PAYMENT_METHOD_SERVICE,
  PAYMENT_METHOD_SERVICES,
  PAYMENT_METHOD_TYPE,
  PAYMENT_METHOD_TYPES,
} from '../constants/paymentMethods';
import { TransactionTypes } from '../constants/transactions';
import { getFxRate } from '../lib/currency';
import { sumTransactions } from '../lib/hostlib';
import { findPaymentMethodProvider } from '../lib/payments';
import { reportMessageToSentry } from '../lib/sentry';
import sequelize, { DataTypes, Op } from '../lib/sequelize';
import { isTestToken } from '../lib/stripe';
import { sanitizeTags } from '../lib/tags';
import { formatArrayToString, formatCurrency } from '../lib/utils';

import Collective from './Collective';
import CustomDataTypes from './DataTypes';
import Order from './Order';
import User from './User';

const debug = debugLib('models:PaymentMethod');

class PaymentMethod extends Model<InferAttributes<PaymentMethod>, InferCreationAttributes<PaymentMethod>> {
  declare id: number;
  declare uuid: string;
  declare CreatedByUserId: number;
  declare CollectiveId: number;
  declare name: string;
  declare description: string;
  declare customerId: string;
  declare token: string;
  declare primary: boolean;
  declare monthlyLimitPerMember: number;
  declare currency: SupportedCurrency;
  declare service: PAYMENT_METHOD_SERVICE;
  declare type: PAYMENT_METHOD_TYPE;
  declare data: any;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare confirmedAt: Date;
  declare archivedAt: Date;
  declare expiryDate: Date;
  declare initialBalance: number;
  declare limitedToTags: string[];
  declare batch: string;
  declare limitedToHostCollectiveIds: number[];
  declare SourcePaymentMethodId: number;
  declare saved: boolean;

  // Properties
  declare Collective?: Collective;

  // Instance methods
  declare getCollective: () => Promise<Collective>;
  declare getBalanceForUser: (user: User) => Promise<{ amount: number; currency: SupportedCurrency }>;
  declare canBeUsedForOrder: (order: Order, user: User) => Promise<boolean>;
  declare isConfirmed: () => boolean;
  declare isPaypalPayment: () => Promise<boolean>;
  declare updateBalance: () => Promise<number>;

  // Getter Methods
  declare info?: Partial<PaymentMethod>;

  /**
   * Create or get an existing payment method by uuid
   * This makes sure that the user can use this PaymentMethod
   * @param {*} user req.remoteUser
   * @param {*} paymentMethod { uuid } or { token, CollectiveId, ... } to create a new one and optionally attach it to CollectiveId
   * @post PaymentMethod { id, uuid, service, token, balance, CollectiveId }
   */
  static async getOrCreate(user, paymentMethod) {
    if (!paymentMethod.uuid) {
      // If no UUID provided, we check if this token already exists
      // NOTE: we have to disable this better behavior because it's breaking too many tests
      /*
      if (paymentMethod.token) {
        const paymentMethodWithToken = await PaymentMethod.findOne({
          where: { token: paymentMethod.token },
        });
        if (paymentMethodWithToken) {
          return paymentMethodWithToken;
        }
      }
      */
      // If no UUID provided, we create a new paymentMethod
      const paymentMethodData = {
        ...paymentMethod,
        service: paymentMethod.service || 'stripe',
        CreatedByUserId: user.id,
        CollectiveId: paymentMethod.CollectiveId, // might be null if the user decided not to save the credit card on file
      };
      debug('PaymentMethod.create', paymentMethodData);
      return PaymentMethod.create(paymentMethodData);
    } else {
      return PaymentMethod.findOne({
        where: { uuid: paymentMethod.uuid },
      }).then(pm => {
        if (!pm) {
          throw new Error("You don't have a payment method with that uuid");
        }
        return pm;
      });
    }
  }
}

PaymentMethod.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    uuid: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      unique: true,
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

    /**
     * Can be NULL when the user doesn't want to remember the payment method information (e.g. credit card info)
     * In that case we still need to store it for archive reasons (we want to be able to print the invoice and show the payment method that has been used)
     * But in the case, we don't link the payment method to the User/Org CollectiveId.
     */
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    name: DataTypes.STRING, // custom human readable identifier for the payment method
    description: DataTypes.STRING, // custom human readable description
    customerId: DataTypes.STRING, // stores the id of the customer from the payment processor at the platform level
    token: DataTypes.STRING,
    primary: DataTypes.BOOLEAN,

    // Monthly limit in cents for each member of this.CollectiveId (in the currency of that collective)
    monthlyLimitPerMember: {
      type: DataTypes.INTEGER,
      validate: {
        min: 0,
      },
    },

    currency: CustomDataTypes(DataTypes).currency,

    service: {
      type: DataTypes.STRING,
      defaultValue: 'stripe',
      validate: {
        isIn: {
          args: [PAYMENT_METHOD_SERVICES],
          msg: `Must be in ${PAYMENT_METHOD_SERVICES}`,
        },
      },
    },

    type: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [PAYMENT_METHOD_TYPES],
          msg: `Must be in ${PAYMENT_METHOD_TYPES}`,
        },
      },
    },

    data: DataTypes.JSONB,

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    confirmedAt: {
      type: DataTypes.DATE,
    },

    archivedAt: {
      type: DataTypes.DATE,
    },

    expiryDate: {
      type: DataTypes.DATE,
    },

    //  Initial balance on this payment method. Current balance should be a computed value based on transactions.
    initialBalance: {
      type: DataTypes.INTEGER,
      validate: {
        min: 0,
      },
    },

    // if not null, this payment method can only be used for collectives that have one the tags
    limitedToTags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      set(tags: string[] | null) {
        this.setDataValue('limitedToTags', sanitizeTags(tags));
      },
    },

    // To group multiple payment methods. Used for Gift Card
    batch: {
      type: DataTypes.STRING,
      allowNull: true,
      set(batchName: string) {
        if (batchName) {
          batchName = batchName.trim();
        }

        this.setDataValue('batch', batchName || null);
      },
    },

    // if not null, this payment method can only be used for collectives hosted by these collective ids
    limitedToHostCollectiveIds: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
    },

    SourcePaymentMethodId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'PaymentMethods',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    saved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    paranoid: true,

    hooks: {
      beforeCreate: instance => {
        if (instance.service !== 'opencollective') {
          if (!instance.token && !instance.isPaypalPayment()) {
            throw new Error(`${instance.service} payment method requires a token`);
          }
          if (
            instance.service === 'stripe' &&
            instance.type === 'creditcard' &&
            !instance.token.match(/^(tok|src|pm)_[a-zA-Z0-9]{24}/)
          ) {
            if (config.env !== 'production' && isTestToken(instance.token)) {
              // test token for end to end tests
            } else {
              throw new Error(`Invalid Stripe token ${instance.token}`);
            }
          }
        }
      },
    },

    getterMethods: {
      // Info.
      info() {
        return {
          id: this.id,
          uuid: this.uuid,
          token: this.token,
          service: this.service,
          type: this.type,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          confirmedAt: this.confirmedAt,
          name: this.name,
          data: this.data,
        };
      },

      features() {
        return findPaymentMethodProvider(this).features;
      },

      minimal() {
        return {
          id: this.id,
          CreatedByUserId: this.CreatedByUserId,
          CollectiveId: this.CollectiveId,
          service: this.service,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          confirmedAt: this.confirmedAt,
          expiryDate: this.expiryDate,
        };
      },
    },
  },
);

/**
 * Instance Methods
 */

/**
 * Returns true if this payment method can be used for the given order
 * based on available balance and user
 * @param {Object} order { totalAmount, currency }
 * @param {Object} user instanceof User
 */
PaymentMethod.prototype.canBeUsedForOrder = async function (order, user) {
  // if the user is trying to reuse an existing payment method,
  // we make sure it belongs to the logged in user or to a collective that the user is an admin of
  if (!user) {
    throw new Error('You need to be logged in to be able to use a payment method on file');
  }

  const name = `payment method (${this.service}:${this.type})`;

  if (this.expiryDate && new Date(this.expiryDate) < new Date()) {
    throw new Error(`This ${name} has expired`);
  }

  if (order.interval && !get(this.features, 'recurring')) {
    throw new Error(`This ${name} doesn't support recurring payments`);
  }

  if (this.limitedToTags) {
    const collective = order.collective || (await order.getCollective());
    if (intersection(collective.tags, this.limitedToTags).length === 0) {
      throw new Error(
        `This payment method can only be used for collectives in ${formatArrayToString(this.limitedToTags)}`,
      );
    }
  }

  // quick helper to get the name of a collective given its id to format better error messages
  const fetchCollectiveName = CollectiveId => {
    return (
      CollectiveId &&
      Collective.findOne({
        attributes: ['name'],
        where: { id: CollectiveId },
      }).then(r => r && r.name)
    );
  };

  if (this.limitedToHostCollectiveIds) {
    const collective = order.collective || (await order.getCollective());
    if (!this.limitedToHostCollectiveIds.includes(collective.HostCollectiveId)) {
      const hostCollectives = await Promise.all(this.limitedToHostCollectiveIds.map(fetchCollectiveName));
      throw new Error(
        `This payment method can only be used for collectives hosted by ${formatArrayToString(hostCollectives)}`,
      );
    }
  }

  // If there is no `this.CollectiveId`, it means that the user doesn't want to save this payment method to any collective
  // In that case, we need to check that the user is the creator of the payment method
  if (!this.CollectiveId) {
    if (user.id !== this.CreatedByUserId) {
      throw new Error(
        'This payment method is not saved to any collective and can only be used by the user that created it',
      );
    }
  } else {
    const collective = await Collective.findByPk(this.CollectiveId);

    // If there is a monthly limit per member, the user needs to be a member or admin of the collective that owns the payment method
    if (this.monthlyLimitPerMember && !user.isMemberOfCollective(collective)) {
      throw new Error(
        "You don't have enough permissions to use this payment method (you need to be a member or an admin of the collective that owns this payment method)",
      );
    }

    // If there is no monthly limit, the user needs to be an admin of the collective that owns the payment method (or its host)
    if (!this.monthlyLimitPerMember && !user.isAdminOfCollectiveOrHost(collective) && this.type !== 'manual') {
      throw new Error(
        "You don't have enough permissions to use this payment method (you need to be an admin of the collective that owns this payment method)",
      );
    }
  }

  // We get an estimate of the total amount of the order in the currency of the payment method
  const orderCurrency = order.currency || get(order, 'collective.currency');
  const fxrate = await getFxRate(orderCurrency, this.currency);
  const totalAmountInPaymentMethodCurrency = order.totalAmount * fxrate;
  let orderAmountInfo = formatCurrency(order.totalAmount, orderCurrency);
  if (orderCurrency !== this.currency) {
    orderAmountInfo += ` ~= ${formatCurrency(totalAmountInPaymentMethodCurrency, this.currency)}`;
  }
  if (this.monthlyLimitPerMember && totalAmountInPaymentMethodCurrency > this.monthlyLimitPerMember) {
    throw new Error(
      `The total amount of this order (${orderAmountInfo}) is higher than your monthly spending limit on this ${name} (${formatCurrency(
        this.monthlyLimitPerMember,
        this.currency,
      )})`,
    );
  }

  const balance = await this.getBalanceForUser(user);
  if (balance && totalAmountInPaymentMethodCurrency > balance.amount) {
    throw new Error(
      `You don't have enough funds available (${formatCurrency(
        balance.amount,
        this.currency,
      )} left) to execute this order (${orderAmountInfo})`,
    );
  }

  return true;
};

/**
 * Updates the paymentMethod.data with the balance on the preapproved paypal card
 */
PaymentMethod.prototype.updateBalance = async function () {
  if (this.service !== 'paypal') {
    throw new Error('Can only update balance for paypal preapproved cards');
  }
  const paymentProvider = findPaymentMethodProvider(this);
  return await paymentProvider.updateBalance(this);
};

PaymentMethod.prototype.isPaypalPayment = async function () {
  return Boolean(this.service === 'paypal' && this.type === 'payment');
};

/**
 * getBalanceForUser
 * Returns the available balance of the current payment method based on:
 * - the balance of CollectiveId if service is opencollective
 * - the monthlyLimitPerMember if any and if the user is a member
 * - the available balance on the paykey for PayPal (not implemented yet)
 */
PaymentMethod.prototype.getBalanceForUser = async function (user) {
  if (user && !(user instanceof User)) {
    throw new Error('Internal error at PaymentMethod.getBalanceForUser(user): user is not an instance of User');
  }

  const paymentProvider = findPaymentMethodProvider(this, { throwIfMissing: false });
  if (!paymentProvider) {
    return { amount: 0, currency: this.currency };
  }

  const getBalance = async () => {
    if (!paymentProvider.getBalance) {
      return { amount: maxInteger, currency: this.currency }; // GraphQL doesn't like Infinity
    }

    const balance = await paymentProvider.getBalance(this);
    if (typeof balance === 'number') {
      return { amount: balance, currency: this.currency };
    }

    return balance; // as { amount: number; currency: SupportedCurrency };
  };

  // Paypal Preapproved Key
  if (this.service === 'paypal' && !this.type) {
    return getBalance();
  }

  if (this.monthlyLimitPerMember && !user) {
    console.error(
      '>>> this payment method has a monthly limit. Please provide a user to be able to compute their balance.',
    );
    reportMessageToSentry(
      `This payment method has a monthly limit. Please provide a user to be able to compute their balance.`,
      { extra: { paymentMethod: this.info } },
    );
    return { amount: 0, currency: this.currency };
  }

  if (user) {
    await user.populateRoles();
  }
  // giftcard monthlyLimitPerMember are calculated differently so the getBalance already returns the right result
  if (this.type === 'giftcard') {
    return getBalance();
  }

  // Most paymentMethods getBalance functions return a {amount, currency} object while
  // collective payment method returns a raw number.
  const balance = await getBalance();
  const balanceAmount = typeof balance === 'number' ? balance : balance.amount;

  // Independently of the balance of the external source, the owner of the payment method
  // may have set up a monthlyLimitPerMember or an initialBalance
  if (!this.initialBalance && !this.monthlyLimitPerMember) {
    return { amount: balanceAmount, currency: this.currency };
  }

  let limit = Infinity; // no no, no no no no, no no no no limit!
  const query: any = {
    where: { type: TransactionTypes.DEBIT },
    include: [
      {
        model: PaymentMethod,
        required: true,
        attributes: [],
        where: { [Op.or]: { id: this.id, SourcePaymentMethodId: this.id } },
      },
    ],
  };

  if (this.monthlyLimitPerMember) {
    limit = this.monthlyLimitPerMember;
    const d = new Date();
    const firstOfTheMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    query.where.createdAt = { [Op.gte]: firstOfTheMonth };
    query.where.CreatedByUserId = user.id;
  }

  if (this.initialBalance) {
    limit = this.initialBalance > limit ? limit : this.initialBalance;
  }

  const result = await sumTransactions('netAmountInCollectiveCurrency', query, this.currency);
  const availableBalance = limit + result.totalInHostCurrency; // result.totalInHostCurrency is negative
  return { amount: Math.min(balanceAmount, availableBalance), currency: this.currency };
};

/**
 * Check if gift card is claimed.
 * Always return true for other payment methods.
 */
PaymentMethod.prototype.isConfirmed = function () {
  return this.type !== 'giftcard' || this.confirmedAt !== null;
};

export default PaymentMethod;
