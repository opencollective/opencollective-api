import { TaxType } from '@opencollective/taxes';
import debugLib from 'debug';
import { get } from 'lodash';
import * as Sequelize from 'sequelize';
import { DataTypes, Model, Op, Optional, QueryTypes } from 'sequelize';
import Temporal from 'sequelize-temporal';

import { SupportedCurrency } from '../constants/currencies';
import OrderStatus from '../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import roles from '../constants/roles';
import TierType from '../constants/tiers';
import { PLATFORM_TIP_TRANSACTION_PROPERTIES, TransactionTypes } from '../constants/transactions';
import * as libPayments from '../lib/payments';
import sequelize from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';
import { capitalize } from '../lib/utils';

import type AccountingCategory from './AccountingCategory';
import type Activity from './Activity';
import Collective from './Collective';
import type Comment from './Comment';
import type { MemberModelInterface } from './Member';
import PaymentMethod, { PaymentMethodModelInterface } from './PaymentMethod';
import type { SubscriptionInterface } from './Subscription';
import type Tier from './Tier';
import Transaction, { TransactionInterface } from './Transaction';
import User from './User';

const { models } = sequelize;

const debug = debugLib('models:Order');

export interface OrderAttributes {
  id: number;
  CreatedByUserId?: number;
  CollectiveId?: number;
  currency?: string;
  totalAmount?: number;
  description?: string;
  SubscriptionId?: number;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date;
  PaymentMethodId?: number;
  processedAt?: Date;
  privateMessage?: string;
  TierId?: number;
  FromCollectiveId?: number;
  publicMessage?: string;
  quantity?: number;
  status: string;
  data?: object;
  taxAmount?: number;
  interval?: string;
  tags?: string[];
  platformTipAmount?: number;
  platformTipEligible?: boolean;
  AccountingCategoryId?: number;
}

export type OrderPk = 'id';
export type OrderId = Order[OrderPk];
export type OrderOptionalAttributes =
  | 'id'
  | 'CreatedByUserId'
  | 'CollectiveId'
  | 'currency'
  | 'totalAmount'
  | 'description'
  | 'SubscriptionId'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'PaymentMethodId'
  | 'processedAt'
  | 'privateMessage'
  | 'TierId'
  | 'FromCollectiveId'
  | 'publicMessage'
  | 'quantity'
  | 'status'
  | 'data'
  | 'taxAmount'
  | 'interval'
  | 'tags'
  | 'platformTipAmount'
  | 'platformTipEligible'
  | 'AccountingCategoryId';
export type OrderCreationAttributes = Optional<OrderAttributes, OrderOptionalAttributes>;

export type OrderTax = {
  id: TaxType;
  percentage: number;
  taxedCountry: string;
  taxerCountry: string;
};

type Subscription = SubscriptionInterface;

type AccountingCategoryId = AccountingCategory['id'];
type ActivityId = Activity['id'];
type CollectiveId = Collective['id'];
type CommentId = Comment['id'];
// type PaymentMethodId = PaymentMethodModelInterface['id'];
type SubscriptionId = SubscriptionInterface['id'];
type TierId = Tier['id'];
type TransactionId = TransactionInterface['id'];
type UserId = User['id'];

class Order extends Model<OrderAttributes, OrderCreationAttributes> implements OrderAttributes {
  declare id: number;
  declare CreatedByUserId?: number;
  declare CollectiveId?: number;
  declare currency?: SupportedCurrency;
  declare totalAmount?: number;
  declare description?: string;
  declare SubscriptionId?: number;
  declare createdAt?: Date;
  declare updatedAt?: Date;
  declare deletedAt?: Date;
  declare PaymentMethodId?: number;
  declare processedAt?: Date;
  declare privateMessage?: string;
  declare TierId?: number;
  declare FromCollectiveId?: number;
  declare publicMessage?: string;
  declare quantity?: number;
  declare status: string;
  declare data:
    | {
        hostFeePercent?: number;
        memo?: string;
        tax?: OrderTax;
      }
    | any; // TODO: Remove `any` once we have a proper type for this

  declare taxAmount?: number;
  declare interval?: string;
  declare tags?: string[];
  declare platformTipAmount?: number;
  declare platformTipEligible?: boolean;
  declare AccountingCategoryId?: number;

  // Order belongsTo AccountingCategory via AccountingCategoryId
  declare accountingCategory: AccountingCategory;
  declare getAccountingCategory: Sequelize.BelongsToGetAssociationMixin<AccountingCategory>;
  declare setAccountingCategory: Sequelize.BelongsToSetAssociationMixin<AccountingCategory, AccountingCategoryId>;
  declare createAccountingCategory: Sequelize.BelongsToCreateAssociationMixin<AccountingCategory>;
  // Order belongsTo Collective via CollectiveId
  declare collective: Collective;
  declare getCollective: Sequelize.BelongsToGetAssociationMixin<Collective>;
  declare setCollective: Sequelize.BelongsToSetAssociationMixin<Collective, CollectiveId>;
  declare createCollective: Sequelize.BelongsToCreateAssociationMixin<Collective>;
  // Order belongsTo Collective via FromCollectiveId
  declare fromCollective: Collective;
  declare getFromCollective: Sequelize.BelongsToGetAssociationMixin<Collective>;
  declare setFromCollective: Sequelize.BelongsToSetAssociationMixin<Collective, CollectiveId>;
  declare createFromCollective: Sequelize.BelongsToCreateAssociationMixin<Collective>;
  // Order hasMany Activity via OrderId
  declare activities: Activity[];
  declare getActivities: Sequelize.HasManyGetAssociationsMixin<Activity>;
  declare setActivities: Sequelize.HasManySetAssociationsMixin<Activity, ActivityId>;
  declare addActivity: Sequelize.HasManyAddAssociationMixin<Activity, ActivityId>;
  declare addActivities: Sequelize.HasManyAddAssociationsMixin<Activity, ActivityId>;
  declare createActivity: Sequelize.HasManyCreateAssociationMixin<Activity>;
  declare removeActivity: Sequelize.HasManyRemoveAssociationMixin<Activity, ActivityId>;
  declare removeActivities: Sequelize.HasManyRemoveAssociationsMixin<Activity, ActivityId>;
  declare hasActivity: Sequelize.HasManyHasAssociationMixin<Activity, ActivityId>;
  declare hasActivities: Sequelize.HasManyHasAssociationsMixin<Activity, ActivityId>;
  declare countActivities: Sequelize.HasManyCountAssociationsMixin;
  // Order hasMany Comment via OrderId
  declare comments: Comment[];
  declare getComments: Sequelize.HasManyGetAssociationsMixin<Comment>;
  declare setComments: Sequelize.HasManySetAssociationsMixin<Comment, CommentId>;
  declare addComment: Sequelize.HasManyAddAssociationMixin<Comment, CommentId>;
  declare addComments: Sequelize.HasManyAddAssociationsMixin<Comment, CommentId>;
  declare createComment: Sequelize.HasManyCreateAssociationMixin<Comment>;
  declare removeComment: Sequelize.HasManyRemoveAssociationMixin<Comment, CommentId>;
  declare removeComments: Sequelize.HasManyRemoveAssociationsMixin<Comment, CommentId>;
  declare hasComment: Sequelize.HasManyHasAssociationMixin<Comment, CommentId>;
  declare hasComments: Sequelize.HasManyHasAssociationsMixin<Comment, CommentId>;
  declare countComments: Sequelize.HasManyCountAssociationsMixin;
  // Order hasMany Transaction via OrderId
  declare Transactions: TransactionInterface[];
  declare getTransactions: Sequelize.HasManyGetAssociationsMixin<TransactionInterface>;
  declare setTransactions: Sequelize.HasManySetAssociationsMixin<TransactionInterface, TransactionId>;
  declare addTransaction: Sequelize.HasManyAddAssociationMixin<TransactionInterface, TransactionId>;
  declare addTransactions: Sequelize.HasManyAddAssociationsMixin<TransactionInterface, TransactionId>;
  declare createTransaction: Sequelize.HasManyCreateAssociationMixin<TransactionInterface>;
  declare removeTransaction: Sequelize.HasManyRemoveAssociationMixin<TransactionInterface, TransactionId>;
  declare removeTransactions: Sequelize.HasManyRemoveAssociationsMixin<TransactionInterface, TransactionId>;
  declare hasTransaction: Sequelize.HasManyHasAssociationMixin<TransactionInterface, TransactionId>;
  declare hasTransactions: Sequelize.HasManyHasAssociationsMixin<TransactionInterface, TransactionId>;
  declare countTransactions: Sequelize.HasManyCountAssociationsMixin;
  // Order belongsTo PaymentMethod via PaymentMethodId
  declare paymentMethod: PaymentMethodModelInterface;
  declare getPaymentMethod: Sequelize.BelongsToGetAssociationMixin<PaymentMethodModelInterface>;
  // declare setPaymentMethod: Sequelize.BelongsToSetAssociationMixin<PaymentMethodModelInterface, PaymentMethodId>;
  declare createPaymentMethod: Sequelize.BelongsToCreateAssociationMixin<PaymentMethodModelInterface>;
  // Order belongsTo Subscription via SubscriptionId
  declare Subscription: Subscription;
  declare getSubscription: Sequelize.BelongsToGetAssociationMixin<Subscription>;
  declare setSubscription: Sequelize.BelongsToSetAssociationMixin<Subscription, SubscriptionId>;
  declare createSubscription: Sequelize.BelongsToCreateAssociationMixin<Subscription>;
  // Order belongsTo Tier via TierId
  declare Tier: Tier;
  declare getTier: Sequelize.BelongsToGetAssociationMixin<Tier>;
  declare setTier: Sequelize.BelongsToSetAssociationMixin<Tier, TierId>;
  declare createTier: Sequelize.BelongsToCreateAssociationMixin<Tier>;
  // Order belongsTo User via CreatedByUserId
  declare createdByUser: User;
  declare getCreatedByUser: Sequelize.BelongsToGetAssociationMixin<User>;
  declare setCreatedByUser: Sequelize.BelongsToSetAssociationMixin<User, UserId>;
  declare createCreatedByUser: Sequelize.BelongsToCreateAssociationMixin<User>;

  // Class methods
  declare getOrCreateMembers: () => Promise<[MemberModelInterface, MemberModelInterface]>;
  declare getUser: () => Promise<User | undefined>;
  declare getSubscriptionForUser: (user: User) => Promise<Subscription | null>;
  declare markAsExpired: () => Promise<Order>;
  declare markAsPaid: (user: User) => Promise<Order>;
  declare getTotalTransactions: () => Promise<number> | number;
  declare getUserForActivity: () => Promise<User | undefined>;
  declare validatePaymentMethod: (paymentMethod: PaymentMethodModelInterface) => Promise<PaymentMethodModelInterface>;
  declare populate: () => Promise<Order>;
  declare setPaymentMethod: (paymentMethodData: object) => Promise<Order>;

  declare info: any;

  // Static Methods

  static generateDescription(collective: Collective, amount: number | undefined, interval: string, tier: Tier): string {
    const tierNameInfo = tier?.name ? ` (${tier.name})` : '';
    if (interval) {
      return `${capitalize(interval)}ly financial contribution to ${collective.name}${tierNameInfo}`;
    } else {
      const isRegistration = tier?.type === TierType.TICKET;
      return `${isRegistration ? 'Registration' : 'Financial contribution'} to ${collective.name}${tierNameInfo}`;
    }
  }

  /**
   * Cancels all subscription orders in the given tier
   */
  static cancelActiveOrdersByTierId(tierId: number): Promise<[affectedCount: number]> {
    return Order.update(
      { status: OrderStatus.CANCELLED },
      {
        where: {
          TierId: tierId,
          SubscriptionId: { [Op.not]: null },
          status: {
            [Op.not]: [OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.EXPIRED],
          },
        },
      },
    );
  }

  /**
   * Cancels all subscription orders for the given collective
   */
  static cancelActiveOrdersByCollective(collectiveIds: number | number[]): Promise<[affectedCount: number]> {
    return Order.update(
      { status: OrderStatus.CANCELLED },
      {
        where: {
          FromCollectiveId: collectiveIds,
          SubscriptionId: { [Op.not]: null },
          status: {
            [Op.not]: [OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.EXPIRED],
          },
        },
      },
    );
  }

  /**
   * Cancels all orders with subscriptions that cannot be transferred when changing hosts (i.e. PayPal)
   */
  static cancelNonTransferableActiveOrdersByCollectiveId(collectiveId: number): Promise<[affectedCount: number]> {
    return sequelize.query(
      `
        UPDATE public."Orders"
        SET
          status = 'CANCELLED',
          "updatedAt" = NOW()
        WHERE id IN (
          SELECT "Orders".id FROM public."Orders"
          INNER JOIN public."Subscriptions" ON "Subscriptions".id = "Orders"."SubscriptionId"
          WHERE
            "Orders".status NOT IN ('PAID', 'CANCELLED', 'REJECTED', 'EXPIRED') AND
            "Subscriptions"."isManagedExternally" AND
            "Subscriptions"."isActive" AND
            "Orders"."CollectiveId" = ?
        )
      `,
      {
        type: QueryTypes.UPDATE,
        replacements: [collectiveId],
      },
    );
  }
}

Order.init(
  {
    id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    CreatedByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Users',
        key: 'id',
      },
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Collectives',
        key: 'id',
      },
    },
    currency: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: 'USD',
    },
    totalAmount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 0,
      },
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    SubscriptionId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Subscriptions',
        key: 'id',
      },
    },
    PaymentMethodId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'PaymentMethods',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    processedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    privateMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    TierId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Tiers',
        key: 'id',
      },
    },
    FromCollectiveId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Collectives',
        key: 'id',
      },
    },
    publicMessage: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 1,
      },
    },
    status: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: OrderStatus.NEW,
      validate: {
        isIn: {
          args: [Object.keys(OrderStatus)],
          msg: `Must be in ${Object.keys(OrderStatus)}`,
        },
      },
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    taxAmount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 0,
      },
    },
    interval: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: true,
      validate: {
        validateTags,
      },
      set(tags: string[] | undefined) {
        this.setDataValue('tags', sanitizeTags(tags));
      },
    },
    platformTipAmount: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 0,
      },
    },
    platformTipEligible: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    AccountingCategoryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'AccountingCategories',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
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
    sequelize,
    tableName: 'Orders',
    schema: 'public',
    timestamps: true,
    paranoid: true,

    getterMethods: {
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
          taxAmount: this.taxAmount,
          // introducing 3 new values to clarify
          netAmount: this.totalAmount - this.platformTipAmount,
          platformTipAmount: this.platformTipAmount,
          chargeAmount: this.totalAmount,
          description: this.description,
          privateMessage: this.privateMessage,
          publicMessage: this.publicMessage,
          SubscriptionId: this.SubscriptionId,
          AccountingCategoryId: this.AccountingCategoryId,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          processedAt: this.processedAt,
          isGuest: Boolean(this.data?.isGuest),
          tags: this.tags,
        };
      },
    },

    hooks: {
      beforeSave: order => {
        if ((order.taxAmount || 0) + (order.platformTipAmount || 0) > order.totalAmount) {
          throw new Error('Invalid contribution amount: Taxes and platform tip cannot exceed the total amount');
        }
      },
    },
  },
);

/**
 * Instance Methods
 */

// total Transactions over time for this order
Order.prototype.getTotalTransactions = function (): Promise<number> | number | undefined {
  if (!this.SubscriptionId) {
    return this.totalAmount;
  }
  return Transaction.sum('amount', {
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
    .then(user => PaymentMethod.getOrCreate(user, paymentMethodData))
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
Order.prototype.validatePaymentMethod = function (paymentMethod: PaymentMethodModelInterface) {
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
Order.prototype.getOrCreateMembers = async function (): Promise<[MemberModelInterface, MemberModelInterface]> {
  // Preload data
  this.collective = this.collective || (await this.getCollective());
  let tier;
  if (this.TierId) {
    tier = await this.getTier();
  }
  // Register user as collective backer or an attendee (for events)
  const member = await this.collective.findOrAddUserWithRole(
    { id: this.CreatedByUserId, CollectiveId: this.FromCollectiveId }, // user
    tier?.type === TierType.TICKET ? roles.ATTENDEE : roles.BACKER, // role
    { TierId: this.TierId }, // defaultAttributes
    { order: this }, // context
  );

  // Register user as backer of Open Collective
  let platformTipMember;
  if (this.platformTipAmount) {
    const platform = await Collective.findByPk(PLATFORM_TIP_TRANSACTION_PROPERTIES.CollectiveId);
    platformTipMember = await platform.findOrAddUserWithRole(
      { id: this.CreatedByUserId, CollectiveId: this.FromCollectiveId },
      roles.BACKER,
      {},
      { skipActivity: true },
    );
  }

  return [member, platformTipMember];
};

Order.prototype.markAsExpired = function (): Promise<Order> {
  // TODO: We should create an activity to record who rejected the order
  return this.update({ status: OrderStatus.EXPIRED });
};

Order.prototype.markAsPaid = async function (user: User): Promise<Order> {
  this.paymentMethod = {
    service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
    type: PAYMENT_METHOD_TYPE.MANUAL,
    paid: true,
  };

  await libPayments.executeOrder(user, this);
  return this;
};

Order.prototype.getUser = async function (): Promise<User | undefined> {
  if (this.createdByUser) {
    return this.createdByUser;
  }
  const user = await User.findByPk(this.CreatedByUserId);
  if (user) {
    this.createdByUser = user;
    debug('getUser', user.dataValues);
    return user.populateRoles();
  }
};

// For legacy purpose, we want to get a single user that we will use for:
// - authentication with the PDF service
// - constructing notification/activity objects
// We can't rely on createdByUser because they have moved out of the Organization, Collective, etc ...
Order.prototype.getUserForActivity = async function (): Promise<User | undefined> {
  if (!this.fromCollective) {
    this.fromCollective = await this.getFromCollective();
  }

  if (this.fromCollective.type !== 'USER') {
    const admins = await this.fromCollective.getAdmins();
    if (admins.length > 0) {
      const firstAdminUser = await admins[0].getUser();
      if (firstAdminUser) {
        return firstAdminUser;
      }
    }
  }

  if (!this.createdByUser) {
    this.createdByUser = await this.getUser();
  }

  return this.createdByUser;
};

/**
 * Populate all the foreign keys if necessary
 * (order.fromCollective, order.collective, order.createdByUser, order.tier)
 * @param {*} order
 */
Order.prototype.populate = function (
  foreignKeys = ['FromCollectiveId', 'CollectiveId', 'CreatedByUserId', 'TierId', 'PaymentMethodId'],
) {
  return Promise.all(
    foreignKeys.map(fk => {
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
      return promise().then((obj: object) => {
        this[attribute] = obj;
      });
    }),
  ).then(() => this);
};

Order.prototype.getSubscriptionForUser = async function (user: User): Promise<Subscription | null> {
  if (!this.SubscriptionId) {
    return null;
  }
  await user.populateRoles();
  // this check is necessary to cover organizations as well as user collective
  if (user.isAdmin(this.FromCollectiveId)) {
    return this.getSubscription();
  } else {
    return null;
  }
};

Temporal(Order, sequelize);

export interface OrderModelInterface extends InstanceType<typeof Order> {}

export default Order;
