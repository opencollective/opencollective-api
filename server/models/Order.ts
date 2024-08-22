import { TaxType } from '@opencollective/taxes';
import debugLib from 'debug';
import { get } from 'lodash';
import {
  BelongsToCreateAssociationMixin,
  BelongsToGetAssociationMixin,
  BelongsToSetAssociationMixin,
  CreationOptional,
  ForeignKey,
  HasManyAddAssociationMixin,
  HasManyAddAssociationsMixin,
  HasManyCountAssociationsMixin,
  HasManyCreateAssociationMixin,
  HasManyGetAssociationsMixin,
  HasManyHasAssociationMixin,
  HasManyHasAssociationsMixin,
  HasManyRemoveAssociationMixin,
  HasManyRemoveAssociationsMixin,
  HasManySetAssociationsMixin,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import Temporal from 'sequelize-temporal';

import { roles } from '../constants';
import ActivityTypes from '../constants/activities';
import { SupportedCurrency } from '../constants/currencies';
import OrderStatus from '../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import TierType from '../constants/tiers';
import { PLATFORM_TIP_TRANSACTION_PROPERTIES, TransactionTypes } from '../constants/transactions';
import { executeOrder } from '../lib/payments';
import { optsSanitizeHtmlForSimplified, sanitizeHTML } from '../lib/sanitize-html';
import sequelize, { DataTypes, Op, QueryTypes } from '../lib/sequelize';
import { sanitizeTags, validateTags } from '../lib/tags';
import { capitalize, sleep } from '../lib/utils';

import AccountingCategory from './AccountingCategory';
import Activity from './Activity';
import Collective from './Collective';
import Comment from './Comment';
import CustomDataTypes from './DataTypes';
import { MemberModelInterface } from './Member';
import PaymentMethod from './PaymentMethod';
import Subscription from './Subscription';
import Tier from './Tier';
import Transaction from './Transaction';
import User from './User';

const { models } = sequelize;

const debug = debugLib('models:Order');

export type OrderTax = {
  id: TaxType | `${TaxType}`;
  percentage: number;
  taxedCountry?: string;
  taxerCountry?: string;
  taxIDNumber?: string;
  taxIDNumberFrom?: string;
};

class Order extends Model<InferAttributes<Order>, InferCreationAttributes<Order>> {
  declare id: CreationOptional<number>;
  declare CreatedByUserId: ForeignKey<User['id']>;
  declare CollectiveId: ForeignKey<Collective['id']>;
  declare currency: SupportedCurrency;
  declare totalAmount: number;
  declare description?: string;
  declare SubscriptionId?: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt?: Date;
  declare PaymentMethodId?: ForeignKey<PaymentMethod['id']>;
  declare processedAt?: Date;
  declare privateMessage?: string;
  declare TierId?: ForeignKey<Tier['id']>;
  declare FromCollectiveId: ForeignKey<Collective['id']>;
  declare publicMessage?: string;
  declare quantity?: number;
  declare status: OrderStatus;
  declare data: {
    hostFeePercent?: number;
    paymentProcessorFee?: number;
    memo?: string;
    resumeReason?: string;
    pausedBy?: 'HOST' | 'PLATFORM' | 'USER';
    tax?: OrderTax;
    paymentIntent?: any;
    previousPaymentIntents?: any[];
    customData?: any;
    needsConfirmation?: boolean;
    paypalStatusChangeNote?: string;
    savePaymentMethod?: boolean;
    isBalanceTransfer?: boolean;
    isGuest?: boolean;
    isPendingContribution?: boolean;
    closedReason?: string;
    taxRemovedFromMigration?: OrderTax;
    taxAmountRemovedFromMigration?: number;
    messageForContributors?: string;
    messageSource?: 'PLATFORM' | 'HOST' | 'COLLECTIVE';
    needsAsyncDeactivation?: boolean;
    isOCFShutdown?: boolean;
    resumeContribution?: {
      reminder: number;
      nextReminderDate: Date;
    };
    platformTip?: number;
    fromAccountInfo?: {
      // TODO: type me
    };
  };

  declare taxAmount?: number;
  declare interval?: 'month' | 'year' | null;
  declare tags?: string[];
  declare platformTipAmount: number;
  declare platformTipEligible: boolean;
  declare AccountingCategoryId?: number;

  // Order belongsTo AccountingCategory via AccountingCategory['id']
  declare accountingCategory?: AccountingCategory;
  declare getAccountingCategory: BelongsToGetAssociationMixin<AccountingCategory>;
  declare setAccountingCategory: BelongsToSetAssociationMixin<AccountingCategory, AccountingCategory['id']>;
  declare createAccountingCategory: BelongsToCreateAssociationMixin<AccountingCategory>;

  // Order belongsTo Collective via Collective['id']
  declare collective?: Collective;
  declare getCollective: BelongsToGetAssociationMixin<Collective>;
  declare setCollective: BelongsToSetAssociationMixin<Collective, Collective['id']>;
  declare createCollective: BelongsToCreateAssociationMixin<Collective>;

  // Order belongsTo Collective via Collective['id']
  declare fromCollective?: Collective;
  declare getFromCollective: BelongsToGetAssociationMixin<Collective>;
  declare setFromCollective: BelongsToSetAssociationMixin<Collective, Collective['id']>;
  declare createFromCollective: BelongsToCreateAssociationMixin<Collective>;

  // Order hasMany Activity via OrderId
  declare activities?: Activity[];
  declare getActivities: HasManyGetAssociationsMixin<Activity>;
  declare setActivities: HasManySetAssociationsMixin<Activity, Activity['id']>;
  declare addActivity: HasManyAddAssociationMixin<Activity, Activity['id']>;
  declare addActivities: HasManyAddAssociationsMixin<Activity, Activity['id']>;
  declare createActivity: HasManyCreateAssociationMixin<Activity>;
  declare removeActivity: HasManyRemoveAssociationMixin<Activity, Activity['id']>;
  declare removeActivities: HasManyRemoveAssociationsMixin<Activity, Activity['id']>;
  declare hasActivity: HasManyHasAssociationMixin<Activity, Activity['id']>;
  declare hasActivities: HasManyHasAssociationsMixin<Activity, Activity['id']>;
  declare countActivities: HasManyCountAssociationsMixin;

  // Order hasMany Comment via OrderId
  declare comments?: Comment[];
  declare getComments: HasManyGetAssociationsMixin<Comment>;
  declare setComments: HasManySetAssociationsMixin<Comment, Comment['id']>;
  declare addComment: HasManyAddAssociationMixin<Comment, Comment['id']>;
  declare addComments: HasManyAddAssociationsMixin<Comment, Comment['id']>;
  declare createComment: HasManyCreateAssociationMixin<Comment>;
  declare removeComment: HasManyRemoveAssociationMixin<Comment, Comment['id']>;
  declare removeComments: HasManyRemoveAssociationsMixin<Comment, Comment['id']>;
  declare hasComment: HasManyHasAssociationMixin<Comment, Comment['id']>;
  declare hasComments: HasManyHasAssociationsMixin<Comment, Comment['id']>;
  declare countComments: HasManyCountAssociationsMixin;

  // Order hasMany Transaction via OrderId
  declare Transactions?: Transaction[];
  declare getTransactions: HasManyGetAssociationsMixin<Transaction>;
  declare setTransactions: HasManySetAssociationsMixin<Transaction, Transaction['id']>;
  declare addTransaction: HasManyAddAssociationMixin<Transaction, Transaction['id']>;
  declare addTransactions: HasManyAddAssociationsMixin<Transaction, Transaction['id']>;
  declare createTransaction: HasManyCreateAssociationMixin<Transaction>;
  declare removeTransaction: HasManyRemoveAssociationMixin<Transaction, Transaction['id']>;
  declare removeTransactions: HasManyRemoveAssociationsMixin<Transaction, Transaction['id']>;
  declare hasTransaction: HasManyHasAssociationMixin<Transaction, Transaction['id']>;
  declare hasTransactions: HasManyHasAssociationsMixin<Transaction, Transaction['id']>;
  declare countTransactions: HasManyCountAssociationsMixin;

  // Order belongsTo PaymentMethod via PaymentMethodId
  declare paymentMethod?: PaymentMethod;
  declare getPaymentMethod: BelongsToGetAssociationMixin<PaymentMethod>;
  // declare setPaymentMethod: BelongsToSetAssociationMixin<PaymentMethod, PaymentMethodId>;
  declare createPaymentMethod: BelongsToCreateAssociationMixin<PaymentMethod>;

  // Order belongsTo SubscriptionInterface via SubscriptionInterface['id']
  declare Subscription?: Subscription;
  declare getSubscription: BelongsToGetAssociationMixin<Subscription>;
  declare setSubscription: BelongsToSetAssociationMixin<Subscription, Subscription['id']>;
  declare createSubscription: BelongsToCreateAssociationMixin<Subscription>;

  // Order belongsTo Tier via TierId
  declare tier?: Tier;
  declare Tier?: Tier; // alternative but doesn't come from Sequelize
  declare getTier: BelongsToGetAssociationMixin<Tier>;
  declare setTier: BelongsToSetAssociationMixin<Tier, Tier['id']>;
  declare createTier: BelongsToCreateAssociationMixin<Tier>;

  // Order belongsTo User via CreatedByUserId
  declare createdByUser?: User;
  declare getCreatedByUser: BelongsToGetAssociationMixin<User>;
  declare setCreatedByUser: BelongsToSetAssociationMixin<User, User['id']>;
  declare createCreatedByUser: BelongsToCreateAssociationMixin<User>;

  // Class methods
  declare getOrCreateMembers: () => Promise<[MemberModelInterface, MemberModelInterface]>;
  declare getUser: () => Promise<User | undefined>;
  declare getSubscriptionForUser: (user: User) => Promise<Subscription | null>;
  declare markAsPaid: (user: User) => Promise<Order>;
  declare getTotalTransactions: () => Promise<number> | number;
  declare getUserForActivity: () => Promise<User | undefined>;
  declare validatePaymentMethod: (paymentMethod: PaymentMethod) => Promise<PaymentMethod>;
  declare populate: () => Promise<Order>;
  declare setPaymentMethod: (paymentMethodData: object) => Promise<Order>;
  /**
   * Similar to what we do in `lockExpense`, this locks an order by setting a special flag in `data`
   * to prevent concurrent processing of the same order. This is important because PayPal webhooks
   * can be received multiple times for the same event, and sales can be processed both in the webhook
   * and the direct API call (depending on PayPal's response).
   *
   * Locks have an expiration time (see `clearExpiredLocks`). Orders that are locked for more than the expiration
   * will be automatically unlocked by the system.
   *
   * @param callback - The function to be executed while the order is locked
   * @param options - Additional options
   * @param options.retries - Number of retries before giving up (default: 0)
   * @param options.retryDelay - Interval between retries in milliseconds (default: 500)
   */
  declare lock: <T>(callback: () => T, options?: { retries?: number; retryDelay?: number }) => Promise<T>;
  declare isLocked: () => boolean;
  declare createResumeActivity: (user: User, params: { UserTokenId?: number }) => Promise<void>;
  declare markSimilarPausedOrdersAsCancelled: () => Promise<void>;

  // Getter Methods
  declare info?: Partial<Order>;

  // Instance Methods

  async markAsExpired(user: User) {
    const fromAccount = this.fromCollective || (await this.getFromCollective());
    const toAccount = this.collective || (await this.getCollective());
    const host = toAccount?.HostCollectiveId ? toAccount?.host || (await toAccount.getHostCollective()) : null;
    const tier = this.tier || (await this.getTier());

    await models.Activity.create({
      type: ActivityTypes.ORDER_PENDING_EXPIRED,
      UserId: user?.id,
      CollectiveId: toAccount?.id,
      FromCollectiveId: this.FromCollectiveId,
      OrderId: this.id,
      HostCollectiveId: host?.id,
      data: {
        order: this.info,
        fromAccountInfo: this.data?.fromAccountInfo,
        fromCollective: fromAccount.info,
        host: host ? host.info : null,
        toCollective: toAccount?.info,
        tierName: tier?.name,
      },
    });

    return this.update({ status: OrderStatus.EXPIRED });
  }

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

  static isValidPausedBy(pausedBy: string): pausedBy is Order['data']['pausedBy'] {
    return ['HOST', 'PLATFORM', 'USER'].includes(pausedBy);
  }

  /**
   * Cancels all subscription orders in the given tier
   */
  static async cancelActiveOrdersByTierId(tierId: number): Promise<void> {
    await Order.update(
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
  static async cancelActiveOrdersByCollective(collectiveIds: number | number[]): Promise<void> {
    await Order.update(
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

  /**
   * Clear all lock that timed out (for example, if the server crashed while processing an order).
   * Also record the deadlocks in the order's data.
   */
  static clearExpiredLocks() {
    return sequelize.query(
      `
      UPDATE "Orders"
      SET data = data
        - 'lockedAt'
        || JSONB_BUILD_OBJECT('deadlocks', COALESCE(data -> 'deadlocks', '[]'::JSONB) || TO_JSONB(ARRAY[data ->> 'lockedAt']))
      WHERE data -> 'lockedAt' IS NOT NULL
      AND (data ->> 'lockedAt')::TIMESTAMP < NOW() - INTERVAL '30 minutes'
      AND "deletedAt" IS NULL
    `,
      {
        type: QueryTypes.UPDATE,
      },
    );
  }

  /**
   * Update the status of all non-transferable active orders for the given collective.
   *
   * The only type of contributions that can be transferred are non-Stripe Connect credit card subscriptions.
   * In the future, we could add support for recurring contributions between children and parent collectives.
   *
   * Note: the linked subscriptions will be cancelled in `cron/hourly/70-handle-batch-subscriptions-update.ts`.
   */
  static async stopActiveSubscriptions(
    collectiveId: number,
    newStatus: OrderStatus.CANCELLED | OrderStatus.PAUSED,
    {
      messageForContributors = '',
      messageSource = 'PLATFORM',
    }: { messageForContributors: string; messageSource: 'PLATFORM' | 'COLLECTIVE' | 'HOST' } = {
      messageForContributors: '',
      messageSource: 'PLATFORM',
    },
  ): Promise<void> {
    await sequelize.query(
      `
      UPDATE "Orders"
      SET
        status = :newStatus,
        "updatedAt" = NOW(),
        "data" = COALESCE("data", '{}'::JSONB) || JSONB_BUILD_OBJECT(
          'messageForContributors', :messageForContributors,
          'messageSource', :messageSource,
          'needsAsyncDeactivation', TRUE
        )
      WHERE id IN (
        SELECT "Orders".id FROM "Orders"
        INNER JOIN "Subscriptions" ON "Subscriptions".id = "Orders"."SubscriptionId"
        INNER JOIN "Collectives" c ON c.id = "Orders"."CollectiveId"
        WHERE "Orders"."CollectiveId" = :collectiveId
        AND c."approvedAt" IS NOT NULL
        AND "Subscriptions"."isActive" IS TRUE
        AND "Orders"."status" != :newStatus
        AND "Orders"."deletedAt" IS NULL
        AND "Subscriptions"."deletedAt" IS NULL
      )
    `,
      {
        type: QueryTypes.UPDATE,
        raw: true,
        replacements: {
          collectiveId,
          newStatus,
          messageSource: messageSource || '',
          messageForContributors: messageForContributors
            ? sanitizeHTML(messageForContributors, optsSanitizeHtmlForSimplified)
            : '',
        },
      },
    );
  }
}

Order.init(
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
      set(tags: string[] | undefined) {
        this.setDataValue('tags', sanitizeTags(tags));
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
      allowNull: true,
      defaultValue: null,
      validate: {
        min: 0,
      },
    },

    platformTipEligible: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: null,
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

    AccountingCategoryId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'AccountingCategories' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
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
      defaultValue: OrderStatus.NEW,
      allowNull: false,
      validate: {
        isIn: {
          args: [Object.keys(OrderStatus)],
          msg: `Must be in ${Object.keys(OrderStatus)}`,
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
    sequelize,
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
Order.prototype.getTotalTransactions = function () {
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
  this.fromCollective = this.fromCollective || (await this.getFromCollective());

  // Ignore if the order is from a children collective
  if (this.fromCollective?.ParentCollectiveId === this.collective.id) {
    return;
  }

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

Order.prototype.markAsPaid = async function (user) {
  this.paymentMethod = {
    service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
    type: PAYMENT_METHOD_TYPE.MANUAL,
    paid: true,
  };

  await executeOrder(user, this);
  return this;
};

Order.prototype.getUser = function () {
  if (this.createdByUser) {
    return Promise.resolve(this.createdByUser);
  }
  return User.findByPk(this.CreatedByUserId).then(user => {
    this.createdByUser = user;
    debug('getUser', user.dataValues);
    return user.populateRoles();
  });
};

// For legacy purpose, we want to get a single user that we will use for:
// - authentication with the PDF service
// - constructing notification/activity objects
// We can't rely on createdByUser because they have moved out of the Organization, Collective, etc ...
Order.prototype.getUserForActivity = async function () {
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
      return promise().then(obj => {
        this[attribute] = obj;
      });
    }),
  ).then(() => this);
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

Order.prototype.lock = async function (
  callback,
  { retries = 0, retryDelay = 500 } = {},
): Promise<ReturnType<typeof callback>> {
  // Reload the order and mark it as locked
  const success = await sequelize.transaction(async sqlTransaction => {
    const orderToLock = await models.Order.findByPk(this.id, { transaction: sqlTransaction, lock: true });
    if (!orderToLock) {
      throw new Error('Order not found'); // Not supposed to happen, just in case we try to lock a deleted order
    } else if (orderToLock.isLocked()) {
      return false;
    } else {
      await orderToLock.update(
        { data: { ...orderToLock.data, lockedAt: new Date() } },
        { transaction: sqlTransaction },
      );
      return true;
    }
  });

  // If the order is already locked, we retry
  if (!success) {
    if (retries <= 0) {
      throw new Error('This order is already been processed, please try again later');
    } else {
      await sleep(retryDelay);
      return this.lock(callback, { retries: retries - 1, retryDelay });
    }
  }

  // Call the callback
  try {
    await callback();
    return success;
  } finally {
    // Unlock order
    await sequelize.query(`UPDATE "Orders" SET data = data - 'lockedAt' WHERE id = :orderId`, {
      replacements: { orderId: this.id },
    });
  }
};

Order.prototype.isLocked = function (): boolean {
  return Boolean(this.data?.lockedAt);
};

/**
 * This method is used to unpause an order and generate the corresponding activity.
 *
 * @param user - The user who is unpausing the order
 */
Order.prototype.createResumeActivity = async function (user: User, { UserTokenId = undefined } = {}): Promise<void> {
  const collective = this.collective || (await this.getCollective());
  const HostCollectiveId = collective.HostCollectiveId;
  await Activity.create({
    type: ActivityTypes.SUBSCRIPTION_RESUMED,
    UserId: user.id,
    UserTokenId,
    FromCollectiveId: this.FromCollectiveId,
    OrderId: this.id,
    CollectiveId: this.CollectiveId,
    HostCollectiveId,
    data: {
      order: this.info,
      collective: collective.info,
      user: user.info,
    },
  });
};

/**
 * Marks all other paused orders from the same fromCollective/collective as cancelled.
 */
Order.prototype.markSimilarPausedOrdersAsCancelled = async function (): Promise<void> {
  await models.Order.update(
    { status: OrderStatus.CANCELLED },
    {
      where: {
        id: { [Op.not]: this.id },
        FromCollectiveId: this.FromCollectiveId,
        CollectiveId: this.CollectiveId,
        status: OrderStatus.PAUSED,
      },
    },
  );
};

Temporal(Order, sequelize);

export default Order;
