import config from 'config';
import debugLib from 'debug';
import { get, intersection } from 'lodash-es';
import { InferAttributes, InferCreationAttributes, Model, ModelStatic } from 'sequelize';

import { maxInteger } from '../constants/math.js';
import {
  PAYMENT_METHOD_SERVICE,
  PAYMENT_METHOD_SERVICES,
  PAYMENT_METHOD_TYPE,
  PAYMENT_METHOD_TYPES,
} from '../constants/paymentMethods.js';
import { TransactionTypes } from '../constants/transactions.js';
import { getFxRate } from '../lib/currency.js';
import { sumTransactions } from '../lib/hostlib.js';
import * as libpayments from '../lib/payments.js';
import { reportMessageToSentry } from '../lib/sentry.js';
import sequelize, { DataTypes, Op } from '../lib/sequelize.js';
import { isTestToken } from '../lib/stripe.js';
import { sanitizeTags } from '../lib/tags.js';
import { formatArrayToString, formatCurrency } from '../lib/utils.js';

import Collective from './Collective.js';
import CustomDataTypes from './DataTypes.js';

const debug = debugLib('models:PaymentMethod');

const { models } = sequelize;

interface PaymentMethodStaticInterface {
  payoutMethods: PAYMENT_METHOD_SERVICE[];
  getOrCreate(user, paymentMethod): Promise<PaymentMethodModelInterface>;
}

export interface PaymentMethodModelInterface
  extends Model<InferAttributes<PaymentMethodModelInterface>, InferCreationAttributes<PaymentMethodModelInterface>> {
  id: number;
  uuid: string;
  CreatedByUserId: number;
  CollectiveId: number;
  name: string;
  description: string;
  customerId: string;
  token: string;
  primary: boolean;
  monthlyLimitPerMember: number;
  currency: string;
  service: PAYMENT_METHOD_SERVICE;
  type: PAYMENT_METHOD_TYPE;
  data: any;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date;
  archivedAt: Date;
  expiryDate: Date;
  initialBalance: number;
  limitedToTags: string[];
  batch: string;
  limitedToHostCollectiveIds: number[];
  SourcePaymentMethodId: number;
  saved: boolean;

  getCollective(): Promise<Collective>;
  Collective?: Collective;
}

const PaymentMethod: ModelStatic<PaymentMethodModelInterface> & PaymentMethodStaticInterface = sequelize.define(
  'PaymentMethod',
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

    initialBalance: {
      type: DataTypes.INTEGER,
      description:
        'Initial balance on this payment method. Current balance should be a computed value based on transactions.',
      validate: {
        min: 0,
      },
    },

    limitedToTags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      description: 'if not null, this payment method can only be used for collectives that have one the tags',
      set(tags) {
        this.setDataValue('limitedToTags', sanitizeTags(tags));
      },
    },

    batch: {
      type: DataTypes.STRING,
      allowNull: true,
      description: 'To group multiple payment methods. Used for Gift Cards',
      set(batchName) {
        if (batchName) {
          batchName = batchName.trim();
        }

        this.setDataValue('batch', batchName || null);
      },
    },

    limitedToHostCollectiveIds: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      description: 'if not null, this payment method can only be used for collectives hosted by these collective ids',
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
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          confirmedAt: this.confirmedAt,
          name: this.name,
          data: this.data,
        };
      },

      features() {
        return libpayments.findPaymentMethodProvider(this).features;
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

PaymentMethod.payoutMethods = PAYMENT_METHOD_SERVICES;

/**
 * Instance Methods
 */

/**
 * Returns true if this payment method can be used for the given order
 * based on available balance and user
 * @param {Object} order { totalAmount, currency }
 * @param {Object} user instanceof models.User
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
      models.Collective.findOne({
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
    const collective = await models.Collective.findByPk(this.CollectiveId);

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
  const paymentProvider = libpayments.findPaymentMethodProvider(this);
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
  if (user && !(user instanceof models.User)) {
    throw new Error('Internal error at PaymentMethod.getBalanceForUser(user): user is not an instance of User');
  }

  const paymentProvider = libpayments.findPaymentMethodProvider(this);
  const getBalance =
    paymentProvider && paymentProvider.getBalance ? paymentProvider.getBalance : () => Promise.resolve(maxInteger); // GraphQL doesn't like Infinity

  // Paypal Preapproved Key
  if (this.service === 'paypal' && !this.type) {
    return getBalance(this);
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
    return getBalance(this);
  }

  // Most paymentMethods getBalance functions return a {amount, currency} object while
  // collective payment method returns a raw number.
  const balance = await getBalance(this);
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
        model: models.PaymentMethod,
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

/**
 * Create or get an existing payment method by uuid
 * This makes sure that the user can use this PaymentMethod
 * @param {*} user req.remoteUser
 * @param {*} paymentMethod { uuid } or { token, CollectiveId, ... } to create a new one and optionally attach it to CollectiveId
 * @post PaymentMethod { id, uuid, service, token, balance, CollectiveId }
 */
PaymentMethod.getOrCreate = async (user, paymentMethod) => {
  if (!paymentMethod.uuid) {
    // If no UUID provided, we check if this token already exists
    // NOTE: we have to disable this better behavior because it's breaking too many tests
    /*
      if (paymentMethod.token) {
        const paymentMethodWithToken = await models.PaymentMethod.findOne({
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
};

export default PaymentMethod;
